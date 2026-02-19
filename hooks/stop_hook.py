#!/usr/bin/env python3
"""
byomem Stop hook — enqueues session data for background processing.

Fires after every Claude Code response via the Stop hook mechanism.
Reads session data from stdin JSON, writes a queue job, and spawns
the background worker. Returns in <100ms so Claude Code is not blocked.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

# Allow imports from the parent directory (byomem root)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _log(event: str, **kwargs):
    """Write structured log line to stderr."""
    entry = {"event": event, **kwargs}
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
    from core.models import QueueJob
    from core.queue import enqueue, get_session_offset, has_pending_job

    # Read stdin before anything else
    data = json.loads(sys.stdin.read())
    session_id = data["session_id"]
    transcript = Path(data["transcript_path"])
    cwd = data.get("cwd", "")

    _log("hook_start", session_id=session_id)

    if not transcript.exists():
        _log("hook_complete", reason="transcript_not_found")
        return

    # Skip if a job for this session is already queued or processing
    if has_pending_job(session_id):
        _log("hook_complete", reason="already_queued", session_id=session_id)
        return

    # Record byte offset so worker only reads new content
    offset = get_session_offset(session_id)
    file_size = transcript.stat().st_size
    if offset >= file_size:
        _log("hook_complete", reason="no_new_content", session_id=session_id)
        return

    job = QueueJob(
        session_id=session_id,
        transcript_path=str(transcript),
        cwd=cwd,
        transcript_offset=offset,
    )

    enqueue(job)
    _log("hook_enqueued", session_id=session_id, offset=offset)

    # In tests or sync mode, run worker inline
    if os.environ.get("BYOMEM_SYNC") or os.environ.get("PYTEST_CURRENT_TEST"):
        from core.worker import run_worker
        run_worker()
        _log("hook_complete", session_id=session_id, mode="sync")
        return

    # Spawn detached worker
    _spawn_worker()
    _log("hook_complete", session_id=session_id, mode="async")


if __name__ == "__main__":
    main()
