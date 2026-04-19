#!/usr/bin/env python3
"""
byomem bridge for OpenCode — receives pre-extracted messages via stdin JSON,
writes a Claude-compatible JSONL transcript, and enqueues for processing.

Input (stdin JSON):
{
  "session_id": "ses_abc123...",
  "cwd": "/path/to/project",
  "messages": [
    {"id": "msg_1", "role": "user", "text": "...", "timestamp": "2025-01-01T00:00:00Z"},
    {"id": "msg_2", "role": "assistant", "text": "...", "timestamp": "2025-01-01T00:00:01Z"},
    ...
  ]
}

The JSONL file is written to ~/.byomem/opencode/{session_prefix}.jsonl
and processed by the standard byomem queue/worker pipeline.

Design notes:
- The JSONL file is overwritten (not appended) with the full message history
  each time. QueueJob uses transcript_offset=0 so the parser reads from the
  start and relies on branch.last_turn_id (since_id) to skip already-
  processed turns.
- Atomic write (tmp + rename) prevents corruption if the worker is reading
  the file concurrently.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _log(event: str, **kwargs):
    """Write structured log line to stderr."""
    entry = {"event": event, "source": "opencode", **kwargs}
    sys.stderr.write(json.dumps(entry) + "\n")


def _spawn_worker():
    """Spawn the queue worker as a fully detached background process."""
    worker_script = Path(__file__).resolve().parent / "queue_worker.py"
    byomem_root = Path(__file__).resolve().parent.parent
    python = sys.executable

    subprocess.Popen(
        [python, str(worker_script)],
        cwd=str(byomem_root),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def main():
    from core.config import get_config
    from core.models import QueueJob
    from core.queue import enqueue, has_pending_job

    data = json.loads(sys.stdin.read())
    session_id = data["session_id"]
    cwd = data.get("cwd", "")
    messages = data.get("messages", [])

    _log("bridge_start", session_id=session_id, message_count=len(messages))

    if not messages:
        _log("bridge_skip", reason="no_messages")
        return

    if has_pending_job(session_id):
        _log("bridge_skip", reason="already_queued", session_id=session_id)
        return

    # Write messages as Claude-compatible JSONL
    cfg = get_config()
    transcript_dir = cfg.byomem / "opencode"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = transcript_dir / f"{session_id[:16]}.jsonl"

    lines = []
    for msg in messages:
        line = {
            "type": msg["role"],
            "uuid": msg["id"],
            "timestamp": msg.get("timestamp", ""),
            "message": {"content": msg.get("text", "")},
        }
        lines.append(json.dumps(line))

    content = "\n".join(lines) + "\n"

    # Atomic write: temp file + rename (prevents corruption on concurrent reads)
    tmp_path = transcript_path.with_suffix(".tmp")
    try:
        tmp_path.write_text(content)
        tmp_path.rename(transcript_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    # Enqueue with offset=0 — parser uses branch.last_turn_id for dedup
    job = QueueJob(
        session_id=session_id,
        transcript_path=str(transcript_path),
        cwd=cwd,
        transcript_offset=0,
    )

    enqueue(job)
    _log("bridge_enqueued", session_id=session_id)

    if os.environ.get("BYOMEM_SYNC") or os.environ.get("PYTEST_CURRENT_TEST"):
        from core.worker import run_worker

        run_worker()
        _log("bridge_complete", session_id=session_id, mode="sync")
        return

    _spawn_worker()
    _log("bridge_complete", session_id=session_id, mode="async")


if __name__ == "__main__":
    main()
