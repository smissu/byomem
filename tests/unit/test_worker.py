"""Tests for core/worker.py — background job processing."""
import json
import os
import threading
import time

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


def test_run_worker_writes_history(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed):
    """Processing a job appends an entry to history.jsonl."""
    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)

    enqueue(job)
    run_worker()

    history_path = tmp_byomem / "queue" / "history.jsonl"
    assert history_path.exists()
    lines = history_path.read_text().strip().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["session"] == "sess1234"
    assert entry["model"] == "anthropic"
    assert entry["status"] == "ok"
    assert entry["duration_s"] >= 0


def test_run_worker_logs_retry_then_failed(tmp_path, tmp_byomem, monkeypatch):
    """First failure retries, second failure moves to failed/.

    The worker loop re-checks for pending jobs, so a single run_worker()
    call handles both the retry and the final failure.
    """
    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)

    def fail_process(job, *, model_override=None):
        raise RuntimeError("boom")

    monkeypatch.setattr("core.worker.process_job", fail_process)

    enqueue(job)
    run_worker()

    # Worker loop: first attempt -> retry (requeue), second attempt -> failed
    history_path = tmp_byomem / "queue" / "history.jsonl"
    assert history_path.exists()
    lines = history_path.read_text().strip().splitlines()
    assert len(lines) == 2
    entry1 = json.loads(lines[0])
    assert entry1["status"] == "retry"
    assert entry1["session"] == "sess1234"
    entry2 = json.loads(lines[1])
    assert entry2["status"] == "failed"

    # Verify job is in failed/ dir
    failed_dir = tmp_byomem / "queue" / "failed"
    assert len(list(failed_dir.glob("*.json"))) == 1


def test_enrich_mode_embeds_turn_id(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed, monkeypatch):
    """Enrich mode: verify commit.md contains <!-- turn: --> after processing."""
    from core.config import Config

    test_config = Config(byomem=tmp_byomem, log_search_mode="enrich")
    monkeypatch.setattr("core.config._config", test_config)

    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)
    process_job(job)

    project_dir = tmp_byomem / "testproject" / "branches"
    branches = list(project_dir.iterdir())
    assert len(branches) == 1
    commit_content = (branches[0] / "commit.md").read_text()
    assert "<!-- turn: uuid-user-001 -->" in commit_content


def test_index_mode_indexes_log(tmp_path, tmp_byomem, mock_anthropic, mock_openai_embed, monkeypatch):
    """Index mode: verify log.md appears in search DB after processing."""
    from core.config import Config
    from core.search_index import get_db

    test_config = Config(byomem=tmp_byomem, log_search_mode="index")
    monkeypatch.setattr("core.config._config", test_config)

    transcript = _make_transcript(tmp_path)
    job = _make_job(transcript)
    process_job(job)

    db = get_db()
    rows = db.execute("SELECT path FROM files WHERE path LIKE '%log.md'").fetchall()
    assert len(rows) >= 1
    assert any("log.md" in r[0] for r in rows)
    db.close()


def test_resolve_project_name_git_root(tmp_path):
    """_resolve_project_name walks up to git root."""
    from core.worker import _resolve_project_name

    # Create a fake project with .git dir and a subdirectory
    project_root = tmp_path / "myproject"
    project_root.mkdir()
    (project_root / ".git").mkdir()
    subdir = project_root / "frontend" / "src"
    subdir.mkdir(parents=True)

    assert _resolve_project_name(str(subdir)) == "myproject"
    assert _resolve_project_name(str(project_root / "frontend")) == "myproject"
    assert _resolve_project_name(str(project_root)) == "myproject"


def test_resolve_project_name_no_git(tmp_path):
    """_resolve_project_name falls back to leaf dir name without .git."""
    from core.worker import _resolve_project_name

    subdir = tmp_path / "somedir" / "subdir"
    subdir.mkdir(parents=True)
    assert _resolve_project_name(str(subdir)) == "subdir"


def test_resolve_project_name_empty():
    """_resolve_project_name returns 'unknown' for empty cwd."""
    from core.worker import _resolve_project_name

    assert _resolve_project_name("") == "unknown"


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


# ---------------------------------------------------------------------------
# Parallel worker tests
# ---------------------------------------------------------------------------

def test_parallel_processing_uses_thread_pool(
    tmp_path, tmp_byomem, monkeypatch,
):
    """With max_workers=3 and 6 jobs, all 6 complete and processing overlaps."""
    from core.config import Config

    test_config = Config(byomem=tmp_byomem, max_workers=3)
    monkeypatch.setattr("core.config._config", test_config)

    threads_seen = []
    lock = threading.Lock()

    def fake_process(job, *, model_override=None):
        with lock:
            threads_seen.append(threading.current_thread().name)
        time.sleep(0.05)  # simulate I/O

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 6, tmp_byomem)
    run_worker()

    # All 6 jobs should have been processed
    assert len(threads_seen) == 6
    # With max_workers=3, we should see byomem-prefixed thread names
    pool_threads = [t for t in threads_seen if t.startswith("byomem")]
    assert len(pool_threads) == 6, f"Expected pool threads, got: {threads_seen}"
    # Multiple distinct threads should have been used
    assert len(set(pool_threads)) > 1, f"Expected >1 distinct threads, got: {set(pool_threads)}"


def test_sequential_fallback_with_one_worker(
    tmp_path, tmp_byomem, monkeypatch,
):
    """With max_workers=1, all jobs run sequentially in the main thread."""
    from core.config import Config

    test_config = Config(byomem=tmp_byomem, max_workers=1)
    monkeypatch.setattr("core.config._config", test_config)

    threads_seen = []

    def fake_process(job, *, model_override=None):
        threads_seen.append(threading.current_thread().name)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 4, tmp_byomem)
    run_worker()

    assert len(threads_seen) == 4
    # All should run in the same thread (no pool threads)
    pool_threads = [t for t in threads_seen if t.startswith("byomem")]
    assert len(pool_threads) == 0, f"Expected no pool threads with max_workers=1, got: {threads_seen}"


def test_overflow_with_parallel(
    tmp_path, tmp_byomem_ollama, monkeypatch,
):
    """Overflow split + parallel: both primary and overflow threads parallelize."""
    from core.config import Config

    test_config = Config(
        byomem=tmp_byomem_ollama,
        summarizer_model="qwen3:4b",
        summarizer_fallback_model="qwen2.5:3b",
        summarizer_base_url="http://localhost:11434/v1",
        overflow_threshold=2,
        max_workers=4,
    )
    monkeypatch.setattr("core.config._config", test_config)

    results = []
    lock = threading.Lock()

    def fake_process(job, *, model_override=None):
        with lock:
            results.append({
                "thread": threading.current_thread().name,
                "override": model_override,
            })
        time.sleep(0.05)

    monkeypatch.setattr("core.worker.process_job", fake_process)

    _enqueue_jobs(tmp_path, 8, tmp_byomem_ollama)
    run_worker()

    assert len(results) == 8
    # Both primary (None) and overflow (qwen2.5:3b) should be present
    overrides = [r["override"] for r in results]
    assert None in overrides
    assert "qwen2.5:3b" in overrides
    # Primary jobs should use pool threads
    primary_threads = {r["thread"] for r in results if r["override"] is None}
    assert any(t.startswith("byomem") for t in primary_threads)
