from __future__ import annotations

import json
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
    has_parent_links = any(
        m.get("parentUUID") for m in messages if m.get("type") == "assistant"
    )

    if has_parent_links:
        # Standard path: match assistant messages to user messages via parentUUID
        for msg in messages:
            if msg.get("type") != "user" or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            assistant_msgs = [
                m for m in messages
                if m.get("parentUUID") == msg["uuid"] and m.get("type") == "assistant"
            ]
            processed.update(m["uuid"] for m in assistant_msgs)
            processed.add(msg["uuid"])

            user_text = _text(msg)[:cfg.user_message_max]
            assistant_text = " ".join(_text(m) for m in assistant_msgs)[:cfg.assistant_message_max]

            if not assistant_text.strip():
                continue

            turns.append(Turn(
                id=msg["uuid"],
                timestamp=msg.get("timestamp", ""),
                user=user_text,
                assistant=assistant_text,
            ))
    else:
        # Fallback: sequential pairing (after context compaction, parentUUID is lost)
        # Pair each user message with the assistant messages that follow it
        for i, msg in enumerate(messages):
            if msg.get("type") != "user" or msg.get("uuid") in processed:
                continue
            if not found_since:
                if msg.get("uuid") == since_id:
                    found_since = True
                continue

            processed.add(msg["uuid"])

            # Collect assistant messages until the next user message
            assistant_msgs = []
            for j in range(i + 1, len(messages)):
                if messages[j].get("type") == "user":
                    break
                if messages[j].get("type") == "assistant":
                    assistant_msgs.append(messages[j])
                    processed.add(messages[j].get("uuid", ""))

            user_text = _text(msg)[:cfg.user_message_max]
            assistant_text = " ".join(_text(m) for m in assistant_msgs)[:cfg.assistant_message_max]

            if not assistant_text.strip():
                continue

            turns.append(Turn(
                id=msg["uuid"],
                timestamp=msg.get("timestamp", ""),
                user=user_text,
                assistant=assistant_text,
            ))

    return turns, end_offset


def _text(msg: dict) -> str:
    content = msg.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""
