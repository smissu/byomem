"""Background worker that processes queued jobs.

Supports dynamic overflow: when queue depth >= overflow_threshold,
spawns a second thread using the fallback model (qwen2.5:3b via
OpenAI-compat) to help drain the queue faster.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path

from core.config import get_config
from core.models import QueueJob
from core.queue import (
    acquire_worker_lock,
    claim_pending,
    complete_job,
    fail_job,
    release_worker_lock,
    retry_job,
    save_session_offset,
)

logger = logging.getLogger("byomem.worker")
_history_lock = threading.Lock()


def process_job(job: QueueJob, *, model_override: str | None = None):
    """Process a single queue job — the heavy lifting previously in stop_hook._process.

    If model_override is set, uses that model via OpenAI-compat instead of
    the native Ollama path (used by overflow worker for non-thinking models).
    """
    import fcntl

    from core.branch_manager import (
        append_to_log,
        commit_milestone,
        get_or_create_branch,
        update_metadata,
    )
    from core.memory_writer import maybe_update_main, maybe_update_project_memory
    from core.parser import parse_new_turns
    from core.search_index import index_file
    from core.summarizer import summarize_batch

    cfg = get_config()
    transcript = Path(job.transcript_path)
    if not transcript.exists():
        logger.warning("Transcript not found: %s", job.transcript_path)
        return

    project = Path(job.cwd).name if job.cwd else "unknown"
    branch = get_or_create_branch(project, job.session_id)

    # File lock to prevent concurrent corruption of this branch
    lock_path = branch.path / ".lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock_file.close()
        return

    try:
        new_turns, end_offset = parse_new_turns(
            transcript, branch.last_turn_id, byte_offset=job.transcript_offset,
        )
        if not new_turns:
            # No new turns but update offset so we don't re-read this range
            save_session_offset(job.session_id, end_offset)
            return

        # Batch summarize for efficiency
        batch_size = cfg.batch_size
        all_summaries = []
        for i in range(0, len(new_turns), batch_size):
            batch = new_turns[i:i + batch_size]
            all_summaries.extend(summarize_batch(batch, model_override=model_override))

        # Apply summaries to branch
        for turn, summary in zip(new_turns, all_summaries):
            turn_dict = turn.model_dump()
            summary_dict = summary.model_dump()

            append_to_log(branch, turn_dict)

            if summary_dict.get("milestone"):
                commit_milestone(branch, summary_dict)
                index_file(branch.commit_md, project)

            if summary_dict.get("important"):
                maybe_update_main(project, summary_dict)
                maybe_update_project_memory(job.cwd, summary_dict)
                main_path = cfg.byomem / project / "main.md"
                if main_path.exists():
                    index_file(main_path, project)

        update_metadata(branch, new_turns[-1].model_dump())
        save_session_offset(job.session_id, end_offset)
    finally:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()


def _log_result(session_id: str, model: str, duration_s: float, status: str):
    """Append one JSON line to the processing history log."""
    cfg = get_config()
    history_path = cfg.queue_path / "history.jsonl"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S"),
        "session": session_id[:8],
        "model": model,
        "duration_s": round(duration_s, 2),
        "status": status,
    }
    with _history_lock:
        with open(history_path, "a") as f:
            f.write(json.dumps(entry) + "\n")


def _process_one(job_file, job, model_label, model_override):
    """Process a single (job_file, job) tuple. Thread-safe."""
    from core.summarizer import get_primary_backend, reset_backend_log

    t0 = time.monotonic()
    try:
        logger.info("Processing job: %s (model=%s)", job.session_id, model_label)
        reset_backend_log()
        process_job(job, model_override=model_override)
        actual_backend = get_primary_backend()
        complete_job(job_file)
        # Only log if summarizer actually ran (skip no-op jobs)
        if actual_backend:
            _log_result(job.session_id, actual_backend, time.monotonic() - t0, "ok")
    except Exception as exc:
        duration = time.monotonic() - t0
        actual_backend = get_primary_backend() or model_label
        error_msg = f"{type(exc).__name__}: {exc}"
        logger.exception("Failed to process job %s", job.session_id)
        if job.retry_count < 1:
            logger.info("Requeueing job %s for retry (attempt %d)", job.session_id, job.retry_count + 1)
            retry_job(job_file, error_msg)
            _log_result(job.session_id, actual_backend, duration, "retry")
        else:
            logger.warning("Job %s failed after retry, moving to failed/", job.session_id)
            fail_job(job_file, error_msg)
            _log_result(job.session_id, actual_backend, duration, "failed")


def _process_jobs(jobs, *, model_override: str | None = None):
    """Process a list of (job_file, job) tuples, with concurrent execution.

    Uses ThreadPoolExecutor when max_workers > 1 for I/O-bound parallelism.
    On failure: if retry_count == 0, move back to pending for one retry.
    If retry_count >= 1 (already retried), move to failed/ for troubleshooting.
    """
    cfg = get_config()
    if model_override:
        model_label = model_override
    elif cfg.summarizer_gemini_cli:
        model_label = cfg.summarizer_gemini_model or "gemini"
    else:
        model_label = cfg.summarizer_model

    workers = cfg.max_workers if not model_override else max(1, cfg.max_workers // 2)
    if workers <= 1:
        # Sequential fallback
        for job_file, job in jobs:
            _process_one(job_file, job, model_label, model_override)
    else:
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="byomem") as pool:
            futures = {
                pool.submit(_process_one, job_file, job, model_label, model_override): job
                for job_file, job in jobs
            }
            for future in as_completed(futures):
                future.result()  # propagate any unhandled exceptions


def run_worker():
    """Main worker loop: acquire lock, process all pending jobs, release lock.

    If pending jobs >= overflow_threshold and a fallback_model is configured,
    splits the work: primary thread uses the native Ollama path (qwen3:4b),
    overflow thread uses the fallback model via OpenAI-compat (qwen2.5:3b).
    """
    if not acquire_worker_lock():
        logger.info("Another worker is running, exiting")
        return

    try:
        while True:
            pending = claim_pending()
            if not pending:
                logger.info("No pending jobs, exiting")
                return

            cfg = get_config()
            use_overflow = (
                len(pending) >= cfg.overflow_threshold
                and cfg.summarizer_fallback_model
                and cfg.summarizer_base_url
            )

            if use_overflow:
                mid = len(pending) // 2
                primary_jobs = pending[:mid]
                overflow_jobs = pending[mid:]

                logger.info(
                    "Queue depth %d >= threshold %d, splitting: %d primary + %d overflow (%s)",
                    len(pending), cfg.overflow_threshold,
                    len(primary_jobs), len(overflow_jobs), cfg.summarizer_fallback_model,
                )

                overflow_thread = threading.Thread(
                    target=_process_jobs,
                    kwargs={
                        "jobs": overflow_jobs,
                        "model_override": cfg.summarizer_fallback_model,
                    },
                    name="overflow-worker",
                    daemon=True,
                )
                overflow_thread.start()

                # Primary processes its share
                _process_jobs(primary_jobs)

                overflow_thread.join(timeout=120)
                if overflow_thread.is_alive():
                    logger.warning("Overflow thread timed out after 120s")
            else:
                _process_jobs(pending)

            # Loop back to check for jobs that arrived while we were processing
            logger.info("Rechecking for new pending jobs")
    finally:
        release_worker_lock()
