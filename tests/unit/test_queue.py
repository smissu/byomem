"""Tests for core/queue.py — file-based job queue."""

import os

from core.models import QueueJob
from core.queue import (
    acquire_worker_lock,
    claim_pending,
    complete_job,
    enqueue,
    release_worker_lock,
)


def _make_job(**overrides) -> QueueJob:
    defaults = {
        "session_id": "abc12345-6789-0000-1111-222233334444",
        "transcript_path": "/tmp/transcript.jsonl",
        "cwd": "/tmp/project",
        "created_at": "2026-02-19T10:00:00",
    }
    defaults.update(overrides)
    return QueueJob(**defaults)


# ---------- enqueue ----------


def test_enqueue_creates_json_file(tmp_byomem):
    job = _make_job()
    path = enqueue(job)

    assert path.exists()
    assert path.suffix == ".json"
    assert path.parent == tmp_byomem / "queue" / "pending"

    restored = QueueJob.model_validate_json(path.read_text())
    assert restored.session_id == job.session_id


# ---------- claim_pending ----------


def test_claim_pending_empty(tmp_byomem):
    assert claim_pending() == []


def test_claim_pending_returns_jobs(tmp_byomem):
    job1 = _make_job(session_id="aaaa1111")
    job2 = _make_job(session_id="bbbb2222")
    enqueue(job1)
    enqueue(job2)

    results = claim_pending()
    assert len(results) == 2
    ids = [job.session_id for _, job in results]
    assert "aaaa1111" in ids
    assert "bbbb2222" in ids
    # Files moved to processing/
    for path, _ in results:
        assert path.parent.name == "processing"


# ---------- complete_job ----------


def test_complete_removes_file(tmp_byomem):
    job = _make_job()
    enqueue(job)
    jobs = claim_pending()
    processing_path = jobs[0][0]
    assert processing_path.exists()

    complete_job(processing_path)
    assert not processing_path.exists()


def test_complete_missing_file_noop(tmp_byomem):
    from pathlib import Path

    complete_job(Path("/nonexistent/file.json"))


# ---------- acquire_worker_lock / release_worker_lock ----------


def test_acquire_lock_succeeds(tmp_byomem):
    result = acquire_worker_lock()
    assert result is True

    pid_file = tmp_byomem / "queue" / "worker.pid"
    assert pid_file.exists()
    assert int(pid_file.read_text().strip()) == os.getpid()
    release_worker_lock()


def test_acquire_lock_fails_when_held(tmp_byomem):
    pid_file = tmp_byomem / "queue" / "worker.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))

    result = acquire_worker_lock()
    assert result is False


def test_stale_lock_cleaned_up(tmp_byomem):
    pid_file = tmp_byomem / "queue" / "worker.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text("99999999")

    result = acquire_worker_lock()
    assert result is True
    assert int(pid_file.read_text().strip()) == os.getpid()
    release_worker_lock()


def test_invalid_job_file_skipped(tmp_byomem):
    """Invalid JSON files in pending/ are renamed to .failed."""
    from core.config import get_config

    cfg = get_config()
    pending = cfg.queue_path / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    bad_file = pending / "bad.json"
    bad_file.write_text("not valid json {{{")

    jobs = claim_pending()
    assert len(jobs) == 0
    assert (pending / "bad.failed").exists()
