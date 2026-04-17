"""Pi adapter for byomem retrieval and explicit manual writes."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import sys

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import get_config
from core.memory_identity import resolve_project_id, resolve_user_id
from core.memory_capture import candidate_to_memory_record, generate_capture_candidate
from core.memory_retrieval import retrieve_memory
from core.memory_store import get_native_store
from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryStoreRequest, MemoryStoreResponse
from core.session_capture import handle_session_capture

_debug_lock = threading.Lock()


def _debug_enabled() -> bool:
    cfg = get_config()
    env_value = __import__("os").environ.get("BYOMEM_DEBUG")
    env_enabled = str(env_value).lower() in {"1", "true", "yes", "on"} if env_value is not None else False
    return bool(getattr(cfg, "byomem_debug", False) or env_enabled)


def _debug_path() -> Path:
    return get_config().queue_path / "byomem_adapter_debug.jsonl"


def _project_from_cwd(cwd: str) -> str:
    path = Path(cwd).resolve()
    return path.name or "project"


def _summary_for_count(count: int) -> str:
    if count == 0:
        return "No matching memory items found"
    if count == 1:
        return "1 item found"
    return f"{count} items found"


def _safe_int(value, default: int | None = None) -> int | None:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _safe_preview(text: str, limit: int = 80) -> str:
    compact = " ".join(text.split())
    if not compact:
        return ""
    return f"len={len(text)} preview={compact[:limit]}"


def _debug_log(entry: dict) -> None:
    if not _debug_enabled():
        return
    debug_path = _debug_path()
    debug_path.parent.mkdir(parents=True, exist_ok=True)
    entry["ts"] = _now_iso()
    with _debug_lock:
        with open(debug_path, "a") as f:
            f.write(json.dumps(entry) + "\n")


def _store_native_memory(request: dict, correlation_id: str) -> dict:
    start = time.monotonic()
    text = str(request.get("text", ""))
    _debug_log({"correlation_id": correlation_id, "layer": "python_adapter", "action": "store", "event": "start", "metadata": {"cwd": request.get("cwd"), "scope": request.get("scope", "project"), "text_len": len(text), "summary_present": request.get("summary") is not None, "tags_count": len(request.get("tags", [])) if isinstance(request.get("tags"), list) else None, "text_preview": _safe_preview(text, 48)}})

    summary = request.get("summary")
    if summary is not None and not isinstance(summary, str):
        raise ValueError("summary must be a string or null")
    scope = str(request.get("scope", "project")).strip() or "project"
    store_request = MemoryStoreRequest(
        action="store",
        cwd=str(request.get("cwd", "")).strip(),
        text=text,
        summary=summary,
        scope=scope,
    )
    if not store_request.cwd:
        raise ValueError("cwd is required")
    if store_request.scope not in {"project", "user"}:
        raise ValueError("scope must be project or user")

    project = _project_from_cwd(store_request.cwd)
    project_id = resolve_project_id(store_request.cwd)
    user_id = resolve_user_id()
    scope_id = project_id if store_request.scope == "project" else user_id
    summary = store_request.summary or store_request.text[:80].strip()

    record = MemoryRecord(
        id=str(uuid4()),
        scope=store_request.scope,
        scope_id=scope_id,
        created_at=_now_iso(),
        updated_at=_now_iso(),
        source="pi:store",
        content=store_request.text,
        tags=store_request.tags,
        source_kind="pi_native_store",
        source_ref=store_request.cwd,
    )
    get_native_store().write(record)
    result = MemoryStoreResponse(
        project=project,
        scope=store_request.scope,
        scope_id=scope_id,
        path=str(get_native_store().path),
        summary=summary,
    )
    _debug_log({"correlation_id": correlation_id, "layer": "python_adapter", "action": "store", "event": "complete", "outcome": "success", "duration_ms": int((time.monotonic() - start) * 1000), "metadata": {"project": project, "scope": store_request.scope, "path": str(get_native_store().path)}})
    return result.model_dump()


def _capture_candidate(request: dict, correlation_id: str) -> dict:
    outcome = str(request.get("outcome", "")).strip()
    cwd = str(request.get("cwd", "")).strip()
    user_hint = request.get("user_hint")
    candidate = generate_capture_candidate(outcome, cwd, user_hint=user_hint)
    return {"candidate": None if candidate is None else candidate.__dict__}


def _approve_capture_candidate(request: dict, correlation_id: str) -> dict:
    candidate_data = request.get("candidate")
    if not isinstance(candidate_data, dict):
        raise ValueError("candidate is required")
    approved = bool(request.get("approved", False))
    if not approved:
        return {"ok": False, "stored": False}
    candidate = generate_capture_candidate(candidate_data.get("text", ""), str(request.get("cwd", "")).strip(), user_hint=request.get("user_hint"))
    if candidate is None:
        raise ValueError("candidate could not be generated")
    record = candidate_to_memory_record(candidate, record_id=str(uuid4()), now_iso=_now_iso(), source="pi:capture")
    get_native_store().write(record)
    return {"ok": True, "stored": True, "scope": record.scope, "scope_id": record.scope_id, "path": str(get_native_store().path)}


def handle_pi_request(request: dict) -> dict:
    start = time.monotonic()
    request_correlation = request.get("correlation_id")
    correlation_id = str(request_correlation).strip() if request_correlation else str(uuid4())
    action = str(request.get("action", "")).strip().lower() or "search"
    _debug_log({"correlation_id": correlation_id, "layer": "python_adapter", "action": action, "event": "start", "metadata": {"cwd": request.get("cwd"), "query_len": len(str(request.get("query", ""))), "query_preview": _safe_preview(str(request.get("query", "")), 48), "max_results": request.get("max_results"), "scope": request.get("scope", "project")}})

    try:
        if action == "store":
            result = _store_native_memory(request, correlation_id)
        elif action == "capture_candidate":
            result = _capture_candidate(request, correlation_id)
        elif action == "approve_capture":
            result = _approve_capture_candidate(request, correlation_id)
        elif action == "session_capture":
            result = handle_session_capture(request)
        else:
            query = str(request.get("query", "")).strip()
            cwd = str(request.get("cwd", "")).strip()
            max_results = _safe_int(request.get("max_results"))
            scope = str(request.get("scope", "project")).strip() or "project"
            if scope not in {"project", "user"}:
                scope = "project"

            scope_id = resolve_project_id(cwd) if scope == "project" else resolve_user_id()
            filters: dict[str, object] = {scope: scope_id, "lifecycle": ["active", "archived", "superseded"]}
            retrieval_request = MemoryRetrievalRequest(query=query, scope=scope, filters=filters)
            response = retrieve_memory(retrieval_request)
            limited = response.results[:max_results] if isinstance(max_results, int) and max_results >= 0 else response.results
            items = [{"text": result.record.content, "source": result.record.source, "path": result.record.source_ref or result.record.source} for result in limited]
            result = {"items": items, "summary": _summary_for_count(len(items))}

        _debug_log({"correlation_id": correlation_id, "layer": "python_adapter", "action": action, "event": "complete", "outcome": "success", "duration_ms": int((time.monotonic() - start) * 1000), "metadata": {"result_count": len(result.get("items", [])) if isinstance(result, dict) else None, "has_summary": bool(result.get("summary")) if isinstance(result, dict) else None}})
        return result
    except Exception as exc:
        _debug_log({"correlation_id": correlation_id, "layer": "python_adapter", "action": action, "event": "failure", "outcome": "error", "duration_ms": int((time.monotonic() - start) * 1000), "metadata": {"error_type": type(exc).__name__, "error": str(exc)[:200]}})
        raise


def handle_pi_json(payload: str) -> str:
    request = json.loads(payload or "{}")
    return json.dumps(handle_pi_request(request))


def main() -> int:
    payload = sys.stdin.read()
    sys.stdout.write(handle_pi_json(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
