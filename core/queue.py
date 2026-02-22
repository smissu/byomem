"""File-based job queue for async stop-hook processing.

Layout under cfg.queue_path (~/.byomem/queue/):
    pending/      <- hook writes here
    processing/   <- worker moves jobs here during processing
    failed/       <- jobs that failed after retry
    offsets.json  <- last-processed byte offset per session
    worker.pid    <- PID lock file
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from core.config import get_config
from core.models import QueueJob

log = logging.getLogger(__name__)


def enqueue(job: QueueJob) -> Path:
    """Write job JSON to pending/ using atomic write (tmp + rename).

    Filename: {timestamp_ms}-{session_id[:8]}.json
    Returns the final Path of the written file.
    """
    cfg = get_config()
    pending = cfg.queue_path / "pending"
    pending.mkdir(parents=True, exist_ok=True)

    ts = int(time.time() * 1000)
    slug = job.session_id[:8]
    name = f"{ts}-{slug}.json"
    final = pending / name
    tmp = pending / f"{name}.tmp"

    tmp.write_text(job.model_dump_json(indent=2))
    tmp.rename(final)
    return final


def claim_pending() -> list[tuple[Path, QueueJob]]:
    """Move all pending/*.json to processing/ and return them oldest-first.

    Invalid files are renamed to .failed (left in pending/).
    """
    cfg = get_config()
    pending = cfg.queue_path / "pending"
    processing = cfg.queue_path / "processing"
    processing.mkdir(parents=True, exist_ok=True)

    if not pending.exists():
        return []

    results: list[tuple[Path, QueueJob]] = []
    for src in sorted(pending.glob("*.json")):
        try:
            job = QueueJob.model_validate_json(src.read_text())
        except Exception:
            src.rename(src.with_suffix(".failed"))
            continue
        dest = processing / src.name
        src.rename(dest)
        results.append((dest, job))
    return results


def complete_job(path: Path) -> None:
    """Delete a processed job file."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def retry_job(path: Path, error: str) -> Path:
    """Move a failed job back to pending/ with incremented retry_count and error recorded."""
    cfg = get_config()
    pending = cfg.queue_path / "pending"
    pending.mkdir(parents=True, exist_ok=True)

    job = QueueJob.model_validate_json(path.read_text())
    job.retry_count += 1
    job.last_error = error

    dest = pending / path.name
    dest.write_text(job.model_dump_json(indent=2))
    path.unlink()
    return dest


def fail_job(path: Path, error: str) -> Path:
    """Move a job to failed/ with the error reason preserved."""
    cfg = get_config()
    failed = cfg.queue_path / "failed"
    failed.mkdir(parents=True, exist_ok=True)

    job = QueueJob.model_validate_json(path.read_text())
    job.last_error = error

    dest = failed / path.name
    dest.write_text(job.model_dump_json(indent=2))
    path.unlink()
    return dest


def has_pending_job(session_id: str) -> bool:
    """Check if a pending or processing job already exists for this session."""
    cfg = get_config()
    slug = session_id[:8]
    for d in ("pending", "processing"):
        d_path = cfg.queue_path / d
        if d_path.exists():
            for f in d_path.glob(f"*-{slug}.json"):
                return True
    return False


def get_session_offset(session_id: str) -> int:
    """Return the last-processed byte offset for a session transcript."""
    cfg = get_config()
    offsets_file = cfg.queue_path / "offsets.json"
    if not offsets_file.exists():
        return 0
    try:
        offsets = json.loads(offsets_file.read_text())
        return offsets.get(session_id, 0)
    except (json.JSONDecodeError, OSError):
        return 0


def save_session_offset(session_id: str, offset: int) -> None:
    """Persist the byte offset after successful processing."""
    cfg = get_config()
    cfg.queue_path.mkdir(parents=True, exist_ok=True)
    offsets_file = cfg.queue_path / "offsets.json"
    offsets = {}
    if offsets_file.exists():
        try:
            offsets = json.loads(offsets_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    offsets[session_id] = offset
    offsets_file.write_text(json.dumps(offsets))


def acquire_worker_lock() -> bool:
    """PID-file based lock. Returns True if acquired.

    If worker.pid exists and the recorded PID is alive, returns False.
    If stale/dead, overwrites. Returns True on success.
    """
    cfg = get_config()
    cfg.queue_path.mkdir(parents=True, exist_ok=True)
    pid_file = cfg.queue_path / "worker.pid"
    my_pid = os.getpid()

    if pid_file.exists():
        try:
            existing_pid = int(pid_file.read_text().strip())
        except (ValueError, OSError):
            existing_pid = None

        if existing_pid is not None:
            try:
                os.kill(existing_pid, 0)
                return False  # Process is alive
            except ProcessLookupError:
                pass  # Stale lock
            except PermissionError:
                return False  # Process exists, can't signal

    pid_file.write_text(str(my_pid))
    return True


def release_worker_lock() -> None:
    """Remove worker.pid if it contains our PID."""
    cfg = get_config()
    pid_file = cfg.queue_path / "worker.pid"
    if not pid_file.exists():
        return
    try:
        stored_pid = int(pid_file.read_text().strip())
        if stored_pid == os.getpid():
            pid_file.unlink(missing_ok=True)
    except (ValueError, OSError):
        pass
