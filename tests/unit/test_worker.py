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


# ---------------------------------------------------------------------------
# Overflow worker tests
# ---------------------------------------------------------------------------

def _enqueue_jobs(tmp_path, n, tmp_byomem):
    """Enqueue n jobs with unique transcripts."""
    paths = []
    for i in range(n):
        transcript = tmp_path / f"transcript_{i}.jsonl"
        transcript.write_text(
            _make_jsonl(
                _user_msg(f"uuid-user-{i:03d}", f"Question {i}"),
                _assistant_msg(f"uuid-asst-{i:03d}", f"Answer {i}", f"uuid-user-{i:03d}"),
            )
        )
        job = QueueJob(
            session_id=f"sess{i:04d}ab",
            transcript_path=str(transcript),
            cwd=f"/tmp/project{i}",
            created_at="2026-02-19T10:00:00",
        )
        paths.append(enqueue(job))
    return paths


def test_overflow_splits_jobs_above_threshold(
    tmp_path, tmp_byomem_ollama, monkeypatch,
):
    """When queue depth >= overflow_threshold, work is split across two threads."""
    from core.config import Config

    test_config = Config(
        byomem=tmp_byomem_ollama,
        summarizer_model="qwen3:4b",
        summarizer_fallback_model="qwen2.5:3b",
        summarizer_base_url="http://localhost:11434/v1",
        overflow_threshold=2,
    )
    monkeypatch.setattr("core.config._config", test_config)

    # Mock process_job to just track calls (no real processing)
    overrides_seen = []

    def fake_process(job, *, model_override=None):
        overrides_seen.append(model_override)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 4, tmp_byomem_ollama)
    run_worker()

    # Should have seen both None (primary) and "qwen2.5:3b" (overflow)
    assert None in overrides_seen, f"Primary worker didn't run: {overrides_seen}"
    assert "qwen2.5:3b" in overrides_seen, f"Overflow worker didn't run: {overrides_seen}"
    assert len(overrides_seen) == 4


def test_no_overflow_below_threshold(
    tmp_path, tmp_byomem_ollama, monkeypatch,
):
    """When queue depth < overflow_threshold, all jobs use primary model."""
    from core.config import Config

    test_config = Config(
        byomem=tmp_byomem_ollama,
        summarizer_model="qwen3:4b",
        summarizer_fallback_model="qwen2.5:3b",
        summarizer_base_url="http://localhost:11434/v1",
        overflow_threshold=10,  # threshold higher than job count
    )
    monkeypatch.setattr("core.config._config", test_config)

    overrides_seen = []

    def fake_process(job, *, model_override=None):
        overrides_seen.append(model_override)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 3, tmp_byomem_ollama)
    run_worker()

    # All should be None (primary model, no overflow)
    assert all(o is None for o in overrides_seen), f"Unexpected overflow: {overrides_seen}"
    assert len(overrides_seen) == 3


def test_no_overflow_without_fallback_model(
    tmp_path, tmp_byomem, monkeypatch,
):
    """Without fallback_model configured, overflow is never triggered."""
    from core.config import Config

    test_config = Config(
        byomem=tmp_byomem,
        overflow_threshold=2,
    )
    monkeypatch.setattr("core.config._config", test_config)

    overrides_seen = []

    def fake_process(job, *, model_override=None):
        overrides_seen.append(model_override)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 4, tmp_byomem)
    run_worker()

    # All None — overflow disabled because no fallback_model
    assert all(o is None for o in overrides_seen)
    assert len(overrides_seen) == 4


def test_overflow_even_split(
    tmp_path, tmp_byomem_ollama, monkeypatch,
):
    """Overflow splits at midpoint: 3 primary + 3 overflow for 6 jobs."""
    from core.config import Config

    test_config = Config(
        byomem=tmp_byomem_ollama,
        summarizer_model="qwen3:4b",
        summarizer_fallback_model="qwen2.5:3b",
        summarizer_base_url="http://localhost:11434/v1",
        overflow_threshold=2,
    )
    monkeypatch.setattr("core.config._config", test_config)

    overrides_seen = []

    def fake_process(job, *, model_override=None):
        overrides_seen.append(model_override)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 6, tmp_byomem_ollama)
    run_worker()

    primary_count = overrides_seen.count(None)
    overflow_count = overrides_seen.count("qwen2.5:3b")
    assert primary_count == 3, f"Expected 3 primary, got {primary_count}"
    assert overflow_count == 3, f"Expected 3 overflow, got {overflow_count}"
