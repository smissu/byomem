from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from core.config import get_config

FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "parity"


def load_parity_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / name).read_text())


def normalize_store_response(response: dict[str, Any]) -> dict[str, Any]:
    path = str(response.get("path", ""))
    if path:
        path = path.replace(str(get_config().byomem), "<BYOMEM_ROOT>")
        path = path.replace("/records.jsonl", "")
    scope_id = str(response.get("scope_id", ""))
    if scope_id.startswith("project_"):
        scope_id = "<PROJECT_SCOPE_ID>"
    return {
        "ok": bool(response.get("ok", True)),
        "project": response.get("project"),
        "scope": response.get("scope"),
        "scope_id": scope_id,
        "path": path,
        "summary": response.get("summary"),
    }


def normalize_search_response(response: dict[str, Any]) -> dict[str, Any]:
    items = []
    for item in response.get("items", []):
        path = str(item.get("path", ""))
        if path:
            path = path.replace(str(get_config().byomem), "<BYOMEM_ROOT>")
            path = path.replace("/records.jsonl", "")
        if item.get("source") == "pi:store":
            path = "pi:store"
        items.append({"text": item.get("text"), "source": item.get("source"), "path": path})
    return {"items": items, "summary": response.get("summary")}


def normalize_session_capture_response(response: dict[str, Any]) -> dict[str, Any]:
    project = response.get("project") or None
    if project == "repo-a":
        project = "repo-a"
    checkpoint_offset = 0 if response.get("result") == "captured" else int(response.get("checkpoint_offset", 0))
    native_record_ids = list(response.get("native_record_ids", []))
    if response.get("result") == "flushed":
        native_record_ids = [record_id.replace(str(get_config().byomem), "<BYOMEM_ROOT>") for record_id in native_record_ids]
    return {
        "ok": bool(response.get("ok", True)),
        "action": response.get("action"),
        "session_id": response.get("session_id"),
        "result": response.get("result"),
        "reason": response.get("reason"),
        "project": project,
        "turns_seen": int(response.get("turns_seen", 0)),
        "new_turns": int(response.get("new_turns", 0)),
        "pending_turns": int(response.get("pending_turns", 0)),
        "checkpoint_offset": checkpoint_offset,
        "flushed_count": int(response.get("flushed_count", 0)),
        "native_written_count": int(response.get("native_written_count", 0)),
        "native_skipped_count": int(response.get("native_skipped_count", 0)),
        "native_record_ids": native_record_ids,
    }
