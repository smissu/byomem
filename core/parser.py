from __future__ import annotations

import json
from collections import deque
from pathlib import Path

from core.config import get_config
from core.models import Turn


def parse_new_turns(
    transcript: Path,
    since_id: str | None = None,
    byte_offset: int = 0,
) -> tuple[list[Turn], int]:
    """Parse new turns from a transcript file.

    Supports both legacy turn-oriented records and current Pi v3 event-oriented
    message records.

    Args:
        transcript: Path to the JSONL transcript.
        since_id: Skip turns up to and including this UUID.
        byte_offset: Start reading from this byte position.

    Returns:
        (turns, new_byte_offset) — the parsed turns and the file position
        after reading, so the caller can persist it for next time.
    """
    cfg = get_config()
    file_size = transcript.stat().st_size
    if file_size == 0:
        return [], 0

    with open(transcript) as f:
        if byte_offset > 0:
            f.seek(byte_offset)
        raw = f.read()
        end_offset = f.tell()

    if not raw.strip():
        return [], end_offset

    messages = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    turns = []
    processed: set[str] = set()
    found_since = since_id is None or byte_offset > 0

    if _looks_like_event_transcript(messages):
        turns = _parse_event_transcript(messages, cfg, since_id, found_since, processed)
    else:
        turns = _parse_legacy_transcript(messages, cfg, since_id, found_since, processed)

    return turns, end_offset


def _parse_event_transcript(
    messages: list[dict],
    cfg,
    since_id: str | None,
    found_since: bool,
    processed: set[str],
) -> list[Turn]:
    turns: list[Turn] = []
    user_messages = [m for m in messages if _event_message_role(m) == "user"]
    message_by_id: dict[str, dict] = {}
    children_by_parent: dict[str, list[dict]] = {}

    for msg in messages:
        top_level_id = msg.get("id") or msg.get("uuid") or _event_message_uuid(msg)
        if top_level_id:
            message_by_id[top_level_id] = msg
        msg_id = _event_message_uuid(msg)
        if msg_id:
            message_by_id[msg_id] = msg
        parent = _event_parent_uuid(msg)
        if parent:
            children_by_parent.setdefault(parent, []).append(msg)

    for msg in user_messages:
        msg_id = _event_message_uuid(msg)
        if not msg_id or msg_id in processed:
            continue
        if not found_since:
            if msg_id == since_id:
                found_since = True
            continue

        processed.add(msg_id)
        assistant_msgs = _collect_event_assistant_chain(msg_id, message_by_id, children_by_parent)
        assistant_text = _join_assistant(assistant_msgs, cfg.assistant_message_max)
        if not assistant_text.strip():
            continue

        turns.append(
            Turn(
                id=msg_id,
                timestamp=_event_message_timestamp(msg),
                user=_event_text(msg)[: cfg.user_message_max],
                assistant=assistant_text,
            )
        )

    return turns


def _parse_legacy_transcript(
    messages: list[dict],
    cfg,
    since_id: str | None,
    found_since: bool,
    processed: set[str],
) -> list[Turn]:
    turns: list[Turn] = []
    has_parent_links = any(_parent_uuid(m) for m in messages if m.get("type") == "assistant")

    if has_parent_links:
        children = _build_children_index(messages)
        for msg in messages:
            if msg.get("type") != "user" or _is_tool_result(msg) or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            assistant_msgs = []
            queue = deque([msg["uuid"]])
            visited = {msg["uuid"]}
            while queue:
                current = queue.popleft()
                for child in children.get(current, []):
                    cid = child.get("uuid")
                    if cid and cid not in visited:
                        visited.add(cid)
                        if child.get("type") == "assistant":
                            assistant_msgs.append(child)
                        queue.append(cid)

            processed.update(m["uuid"] for m in assistant_msgs if m.get("uuid"))
            processed.add(msg["uuid"])

            user_text = _text(msg)[: cfg.user_message_max]
            assistant_text = _join_assistant(assistant_msgs, cfg.assistant_message_max)
            if assistant_text.strip():
                turns.append(Turn(id=msg["uuid"], timestamp=msg.get("timestamp", ""), user=user_text, assistant=assistant_text))
    else:
        for i, msg in enumerate(messages):
            if msg.get("type") != "user" or _is_tool_result(msg) or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            processed.add(msg["uuid"])
            assistant_msgs = []
            for j in range(i + 1, len(messages)):
                if messages[j].get("type") == "user" and not _is_tool_result(messages[j]):
                    break
                if messages[j].get("type") == "assistant":
                    assistant_msgs.append(messages[j])
                    processed.add(messages[j].get("uuid", ""))

            user_text = _text(msg)[: cfg.user_message_max]
            assistant_text = _join_assistant(assistant_msgs, cfg.assistant_message_max)
            if assistant_text.strip():
                turns.append(Turn(id=msg["uuid"], timestamp=msg.get("timestamp", ""), user=user_text, assistant=assistant_text))

    return turns


def _looks_like_event_transcript(messages: list[dict]) -> bool:
    return any(isinstance(m.get("message"), dict) and m.get("type") == "message" for m in messages)


def _event_message(msg: dict) -> dict:
    return msg.get("message", {}) if isinstance(msg.get("message"), dict) else {}


def _event_message_role(msg: dict) -> str | None:
    return _event_message(msg).get("role")


def _event_message_uuid(msg: dict) -> str | None:
    return (
        _event_message(msg).get("uuid")
        or _event_message(msg).get("id")
        or msg.get("uuid")
        or msg.get("id")
    )


def _event_parent_uuid(msg: dict) -> str | None:
    return (
        _event_message(msg).get("parentUUID")
        or _event_message(msg).get("parentUuid")
        or _event_message(msg).get("parentId")
        or msg.get("parentUUID")
        or msg.get("parentUuid")
        or msg.get("parentId")
    )


def _event_message_timestamp(msg: dict) -> str:
    ts = _event_message(msg).get("timestamp") or msg.get("timestamp", "")
    return str(ts) if ts is not None else ""


def _event_text(msg: dict) -> str:
    content = _event_message(msg).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _collect_event_assistant_chain(
    user_id: str,
    message_by_id: dict[str, dict],
    children_by_parent: dict[str, list[dict]],
) -> list[dict]:
    assistant_msgs: list[dict] = []
    queue = deque(children_by_parent.get(user_id, []))
    visited: set[str] = {user_id}

    while queue:
        msg = queue.popleft()
        msg_id = _event_message_uuid(msg)
        if msg_id and msg_id in visited:
            continue
        if msg_id:
            visited.add(msg_id)

        role = _event_message_role(msg)
        if role == "assistant":
            assistant_msgs.append(msg)
            if msg_id:
                queue.extend(children_by_parent.get(msg_id, []))
            continue

        if role == "toolResult":
            if msg_id:
                queue.extend(children_by_parent.get(msg_id, []))
            continue

        if msg_id and msg_id in message_by_id:
            queue.extend(children_by_parent.get(msg_id, []))

    return assistant_msgs


def _join_assistant(msgs: list[dict], max_len: int) -> str:
    """Join text from multiple assistant messages into clean paragraphs.

    Filters empty blocks, strips whitespace, and separates API responses
    with newlines so the summarizer can parse the structure.
    """
    parts = []
    for m in msgs:
        text = _text(m).strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)[:max_len]


def _parent_uuid(msg: dict) -> str | None:
    """Get parent UUID, handling both field name variants."""
    return msg.get("parentUUID") or msg.get("parentUuid")


def _build_children_index(messages: list[dict]) -> dict[str, list[dict]]:
    """Build a parent UUID -> children index for tree traversal."""
    children: dict[str, list[dict]] = {}
    for m in messages:
        parent = _parent_uuid(m)
        if parent:
            children.setdefault(parent, []).append(m)
    return children


def _is_tool_result(msg: dict) -> bool:
    """Check if a user-type message is a tool result rather than a real user message."""
    if msg.get("type") != "user":
        return False
    content = msg.get("message", {}).get("content", "")
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
    return False


def _text(msg: dict) -> str:
    content = msg.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""
