"""Tests for core/worker.py — background job processing."""
import json
import os

from core.models import QueueJob
from core.queue import enqueue
from core.worker import process_job, run_worker


def _make_jsonl(*messages):
    return "\n".join(json.dumps(m) for m in messages) + "\n"


def _user_msg(uuid, content):
    return {
        "type": "user",
        "uuid": uuid,
        "message": {"content": content},
        "timestamp": "2026-02-19T10:00:00",
    }


def _assistant_msg(uuid, content, parent_uuid):
    return {
        "type": "assistant",
        "uuid": uuid,
        "parentUUID": parent_uuid,
        "message": {"content": content},
        "timestamp": "2026-02-19T10:00:01",
    }


def _make_transcript(tmp_path):
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        _make_jsonl(
            _user_msg("uuid-user-001", "Why is the build failing?"),
            _assistant_msg("uuid-asst-001", "The import path is wrong.", "uuid-user-001"),
        )
    )
    return transcript


def _make_job(transcript_path, cwd="/tmp/testproject"):
    return QueueJob(
        session_id="sess1234abcd",
        transcript_path=str(transcript_path),
        cwd=cwd,
        created_at="2026-02-19T10:00:00",
    )


def test_process_job_creates_branch(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed):
    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)

    process_job(job)

    project_dir = tmp_byomem / "testproject" / "branches"
    assert project_dir.exists()
    branches = list(project_dir.iterdir())
    assert len(branches) == 1

    log_md = branches[0] / "log.md"
    assert log_md.exists()
    log_content = log_md.read_text()
    assert "last_id: uuid-user-001" in log_content
    assert "Why is the build failing?" in log_content


def test_run_worker_processes_queue(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed):
    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)

    job_path = enqueue(job)
    assert job_path.exists()

    run_worker()

    # Job file should be gone (moved to processing then deleted)
    assert not job_path.exists()
    # Branch should have been created
    project_dir = tmp_byomem / "testproject" / "branches"
    assert project_dir.exists()
    assert len(list(project_dir.iterdir())) == 1


def test_run_worker_empty_queue(tmp_byomem):
    run_worker()  # Should not raise


def test_run_worker_skips_if_locked(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed):
    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)

    job_path = enqueue(job)

    # Write PID lock with our own PID
    pid_file = tmp_byomem / "queue" / "worker.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))

    run_worker()

    # Job should still exist in pending (worker couldn't acquire lock)
    assert job_path.exists()
    # No branches should have been created
    assert not (tmp_byomem / "testproject" / "branches").exists()
