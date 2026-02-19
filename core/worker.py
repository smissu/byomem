"""Background worker that processes queued jobs.

Supports dynamic overflow: when queue depth >= overflow_threshold,
spawns a second thread using the fallback model (qwen2.5:3b via
OpenAI-compat) to help drain the queue faster.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

from core.config import get_config
from core.models import QueueJob
from core.queue import acquire_worker_lock, claim_pending, complete_job, release_worker_lock

logger = logging.getLogger("byomem.worker")


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
        new_turns = parse_new_turns(transcript, branch.last_turn_id)
        if not new_turns:
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
    finally:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()


def _process_jobs(jobs, *, model_override: str | None = None):
    """Process a list of (job_file, job) tuples, completing each on success."""
    for job_file, job in jobs:
        try:
            logger.info("Processing job: %s (model=%s)", job.session_id, model_override or "primary")
            process_job(job, model_override=model_override)
            complete_job(job_file)
        except Exception:
            logger.exception("Failed to process job %s", job.session_id)


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
        pending = claim_pending()
        if not pending:
            logger.info("No pending jobs")
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
    finally:
        release_worker_lock()
