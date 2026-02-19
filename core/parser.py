import json
from pathlib import Path


def parse_new_turns(transcript: Path, since_id: str | None = None) -> list[dict]:
    raw = transcript.read_text().strip()
    if not raw:
        return []
    lines = raw.splitlines()
    messages = [json.loads(line) for line in lines if line.strip()]
    turns, processed, found_since = [], set(), since_id is None

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

        turns.append({
            "id": msg["uuid"],
            "timestamp": msg.get("timestamp", ""),
            "user": _text(msg)[:2000],
            "assistant": " ".join(_text(m) for m in assistant_msgs)[:3000],
        })

    return turns


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
