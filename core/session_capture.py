from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from core.config import get_config
from core.memory_identity import resolve_project_id
from core.memory_store import get_native_store
from core.memory_writer import maybe_update_main, maybe_update_project_memory
from core.models import MemoryRecord, SessionCaptureRequest, SessionCaptureResponse, Turn, TurnSummary
from core.parser import parse_new_turns
from core.queue import get_session_offset, save_session_offset
from core.summarizer import summarize_batch

SESSION_STATE_FILE = "session_capture_state.json"
DEBUG_LOG_FILE = "byomem_adapter_debug.jsonl"
NATIVE_SOURCE = "pi:session_capture"


@dataclass
class SessionCaptureState:
    offset: int = 0
    pending_turns: list[dict] | None = None
    last_transcript_path: str = ""
    last_cwd: str = ""
    last_agent: str = ""
    last_model: str = ""
    message_count: int = 0

    def __post_init__(self):
        if self.pending_turns is None:
            self.pending_turns = []


def _write_debug_entry(file_name: str, entry: dict) -> None:
    try:
        from core.pi_adapter import _write_debug_entry as adapter_write_debug_entry

        adapter_write_debug_entry(file_name, entry)
    except Exception:
        pass


def _state_path() -> Path:
    return get_config().queue_path / SESSION_STATE_FILE


def _load_all_state() -> dict[str, dict]:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _save_all_state(data: dict[str, dict]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def _load_state(session_id: str) -> SessionCaptureState:
    data = _load_all_state().get(session_id, {})
    return SessionCaptureState(**data)


def _save_state(session_id: str, state: SessionCaptureState) -> None:
    data = _load_all_state()
    data[session_id] = {
        "offset": state.offset,
        "pending_turns": state.pending_turns,
        "last_transcript_path": state.last_transcript_path,
        "last_cwd": state.last_cwd,
        "last_agent": state.last_agent,
        "last_model": state.last_model,
        "message_count": state.message_count,
    }
    _save_all_state(data)


def _clear_state(session_id: str) -> None:
    data = _load_all_state()
    if session_id in data:
        del data[session_id]
        _save_all_state(data)


def _resolve_project_name(cwd: str) -> str:
    if not cwd:
        return "unknown"
    path = Path(cwd)
    for parent in [path, *path.parents]:
        if (parent / ".git").exists():
            return parent.name
        if parent == parent.parent:
            break
    return path.name or "unknown"


def _resolve_scope_id(cwd: str) -> str:
    return resolve_project_id(cwd)


def _native_record_id(session_id: str, turn_id: str, transcript_path: str) -> str:
    return f"session-capture:{session_id}:{turn_id}:{Path(transcript_path).name}"


def _write_native_session_record(*, cwd: str, session_id: str, turn: Turn, summary: TurnSummary, agent: str | None, model: str | None, transcript_path: str, event: str | None) -> tuple[bool, bool]:
    record = MemoryRecord(
        id=_native_record_id(session_id, turn.id, transcript_path),
        scope="project",
        scope_id=_resolve_scope_id(cwd),
        created_at=turn.timestamp or "",
        updated_at=turn.timestamp or "",
        source=NATIVE_SOURCE,
        content=f"{summary.title}: {summary.summary}",
        source_kind="session_capture_summary",
        source_ref=f"{transcript_path}#turn={turn.id}",
        tags=[tag for tag in ["session_capture", agent or "", model or "", event or ""] if tag],
    )
    store = get_native_store()
    existing = []
    if store.path.exists():
        existing = [record.id for record in store.load()]
    duplicate = record.id in existing
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "native_write_attempt", "metadata": {"session_id": session_id, "turn_id": turn.id, "record_id": record.id, "scope_id": record.scope_id, "source_ref": record.source_ref, "store_path": str(store.path), "duplicate": duplicate}})
    if duplicate:
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "native_write_skip", "metadata": {"session_id": session_id, "turn_id": turn.id, "record_id": record.id, "reason": "duplicate"}})
        return False, True
    try:
        store.write(record)
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "native_write_complete", "metadata": {"session_id": session_id, "turn_id": turn.id, "record_id": record.id, "store_path": str(store.path)}})
        return True, False
    except Exception as exc:
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "native_write_error", "metadata": {"session_id": session_id, "turn_id": turn.id, "record_id": record.id, "error_type": type(exc).__name__, "error": str(exc)[:200]}})
        raise


def _is_large_turn(turn: Turn, threshold: int) -> bool:
    return len(turn.user) + len(turn.assistant) >= threshold


def _should_flush(
    pending_turns: list[Turn],
    *,
    final: bool,
    idle: bool,
    threshold_turns: int,
    large_turn_chars: int,
) -> tuple[bool, str]:
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "should_flush_eval", "metadata": {"pending_turns": len(pending_turns), "final": final, "idle": idle, "threshold_turns": threshold_turns, "large_turn_chars": large_turn_chars}})
    if not pending_turns:
        return False, "no-pending-turns"
    if final:
        return True, "final"
    if idle:
        return True, "idle"
    if len(pending_turns) >= threshold_turns:
        return True, "threshold"
    if any(_is_large_turn(turn, large_turn_chars) for turn in pending_turns):
        return True, "large-turn"
    return False, "below-threshold"


def _flush_session_rollup(
    *,
    cwd: str,
    session_id: str,
    pending_turns: list[Turn],
    agent: str | None,
    model: str | None,
    transcript_path: str,
    event: str | None,
    summary_only: bool,
) -> int:
    project = _resolve_project_name(cwd)
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "flush_start", "metadata": {"session_id": session_id, "cwd": cwd, "pending_turns": len(pending_turns), "agent": agent, "model": model, "transcript_path": transcript_path, "event_name": event, "summary_only": summary_only, "project": project}})
    summaries = summarize_batch(pending_turns)
    flushed = 0
    native_written = 0
    native_skipped = 0
    write_markdown = get_config().session_capture_write_markdown
    for turn, summary in zip(pending_turns, summaries):
        summary_dict = summary.model_dump()
        summary_dict["summary"] = (
            f"{summary_dict['summary']} "
            f"[session_id={session_id} agent={agent or 'unknown'} model={model or 'unknown'} "
            f"event={event or 'agent_end'} transcript={transcript_path}]"
        ).strip()
        wrote_native, skipped_native = _write_native_session_record(
            cwd=cwd,
            session_id=session_id,
            turn=turn,
            summary=summary,
            agent=agent,
            model=model,
            transcript_path=transcript_path,
            event=event,
        )
        native_written += int(wrote_native)
        native_skipped += int(skipped_native)
        if write_markdown:
            maybe_update_main(project, summary_dict, turn_id=turn.id)
            if summary_only:
                maybe_update_project_memory(cwd, summary_dict)
        flushed += 1
    return flushed


def handle_session_capture(request: dict) -> dict:
    cfg = get_config()
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "request_received", "metadata": {"has_cwd": bool(request.get("cwd")), "has_session_id": bool(request.get("session_id") or request.get("sessionId")), "has_transcript_path": bool(request.get("transcript_path") or request.get("transcriptPath")), "message_count": request.get("message_count") if isinstance(request.get("message_count"), int) else request.get("messageCount") if isinstance(request.get("messageCount"), int) else None}})
    capture_request = SessionCaptureRequest(**request)
    response = SessionCaptureResponse(session_id=capture_request.session_id, result="skipped")
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "request_parsed", "metadata": {"session_id": capture_request.session_id, "transcript_path": capture_request.transcript_path, "message_count": capture_request.message_count, "event_name": capture_request.event, "final": capture_request.final, "idle": capture_request.idle}})

    if not cfg.session_capture_enabled:
        response.reason = "session capture disabled"
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "skip", "metadata": {"reason": response.reason}})
        return response.model_dump()

    transcript = Path(capture_request.transcript_path)
    if not transcript.exists():
        response.reason = "missing transcript"
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "skip", "metadata": {"reason": response.reason, "transcript_path": capture_request.transcript_path}})
        return response.model_dump()

    if not capture_request.cwd.strip():
        response.reason = "missing cwd"
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "skip", "metadata": {"reason": response.reason}})
        return response.model_dump()

    state = _load_state(capture_request.session_id)
    start_offset = state.offset or get_session_offset(capture_request.session_id)
    new_turns, end_offset = parse_new_turns(transcript, byte_offset=start_offset)
    response.turns_seen = len(state.pending_turns or []) + len(new_turns)
    response.new_turns = len(new_turns)
    response.checkpoint_offset = end_offset
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "parsed_turns", "metadata": {"session_id": capture_request.session_id, "start_offset": start_offset, "end_offset": end_offset, "new_turns": len(new_turns), "pending_turns": len(state.pending_turns or []), "message_count": capture_request.message_count}})

    pending_turns = [Turn(**turn) for turn in (state.pending_turns or [])]
    pending_turns.extend(new_turns)

    state.offset = end_offset
    state.pending_turns = [turn.model_dump() for turn in pending_turns]
    state.last_transcript_path = capture_request.transcript_path
    state.last_cwd = capture_request.cwd
    state.last_agent = capture_request.agent or ""
    state.last_model = capture_request.model or ""
    state.message_count = capture_request.message_count or 0

    should_flush, reason = _should_flush(
        pending_turns,
        final=capture_request.final,
        idle=capture_request.idle,
        threshold_turns=cfg.session_capture_threshold_turns,
        large_turn_chars=cfg.session_capture_large_turn_chars,
    )
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "flush_decision", "metadata": {"reason": reason, "should_flush": should_flush, "pending_turns": len(pending_turns), "final": capture_request.final, "idle": capture_request.idle, "threshold_turns": cfg.session_capture_threshold_turns, "large_turn_chars": cfg.session_capture_large_turn_chars}})

    if len(pending_turns) < cfg.session_capture_min_turns and not capture_request.final and not capture_request.idle:
        _save_state(capture_request.session_id, state)
        save_session_offset(capture_request.session_id, end_offset)
        response.result = "captured"
        response.reason = "checkpointed"
        response.pending_turns = len(pending_turns)
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "persist", "metadata": {"target": "state", "reason": response.reason, "pending_turns": response.pending_turns}})
        return response.model_dump()

    save_session_offset(capture_request.session_id, end_offset)

    if not should_flush:
        _save_state(capture_request.session_id, state)
        response.result = "captured"
        response.reason = reason
        response.pending_turns = len(pending_turns)
        _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "persist", "metadata": {"target": "state", "reason": response.reason, "pending_turns": response.pending_turns}})
        return response.model_dump()

    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "persist_start", "metadata": {"target": "rollup", "pending_turns": len(pending_turns), "summary_only": capture_request.summary_only}})
    flushed = _flush_session_rollup(
        cwd=capture_request.cwd,
        session_id=capture_request.session_id,
        pending_turns=pending_turns,
        agent=capture_request.agent,
        model=capture_request.model,
        transcript_path=capture_request.transcript_path,
        event=capture_request.event,
        summary_only=capture_request.summary_only,
    )
    _clear_state(capture_request.session_id)
    response.result = "flushed"
    response.reason = reason
    response.project = _resolve_project_name(capture_request.cwd)
    response.flushed_count = flushed
    response.pending_turns = 0
    _write_debug_entry(DEBUG_LOG_FILE, {"layer": "python_adapter", "action": "session_capture", "event": "persist_complete", "metadata": {"target": "rollup", "flushed_count": flushed, "reason": reason, "project": response.project}})
    return response.model_dump()
