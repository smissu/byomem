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

    lines = raw.splitlines()
    messages = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    # If we seeked via byte_offset, we're already past old content — skip since_id gate
    turns, processed, found_since = [], set(), since_id is None or byte_offset > 0

    # Check if parentUUID linking is available
    has_parent_links = any(_parent_uuid(m) for m in messages if m.get("type") == "assistant")

    if has_parent_links:
        # Tree traversal: follow parentUUID chain to find all assistant descendants
        children = _build_children_index(messages)
        for msg in messages:
            if msg.get("type") != "user" or _is_tool_result(msg) or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            # BFS to collect all assistant messages in the response tree
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

            if not assistant_text.strip():
                continue

            turns.append(
                Turn(
                    id=msg["uuid"],
                    timestamp=msg.get("timestamp", ""),
                    user=user_text,
                    assistant=assistant_text,
                )
            )
    else:
        # Fallback: sequential pairing (after context compaction, parentUUID is lost)
        # Pair each real user message with assistant messages until the next real user message
        # Tool results (type "user" with tool_result content) are not turn boundaries
        for i, msg in enumerate(messages):
            if msg.get("type") != "user" or _is_tool_result(msg) or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            processed.add(msg["uuid"])

            # Collect assistant messages until the next real user message
            assistant_msgs = []
            for j in range(i + 1, len(messages)):
                if messages[j].get("type") == "user" and not _is_tool_result(messages[j]):
                    break
                if messages[j].get("type") == "assistant":
                    assistant_msgs.append(messages[j])
                    processed.add(messages[j].get("uuid", ""))

            user_text = _text(msg)[: cfg.user_message_max]
            assistant_text = _join_assistant(assistant_msgs, cfg.assistant_message_max)

            if not assistant_text.strip():
                continue

            turns.append(
                Turn(
                    id=msg["uuid"],
                    timestamp=msg.get("timestamp", ""),
                    user=user_text,
                    assistant=assistant_text,
                )
            )

    return turns, end_offset


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
