"""Generate natural language descriptions for code chunks and re-embed them.

Runs as a second pass after indexing: queries chunks without descriptions,
batches them through the summarizer LLM, stores descriptions, and re-embeds
using description text for better semantic search.
"""

import hashlib
import json
import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from core.config import get_config
from core.models import BatchDescriptionResponse

logger = logging.getLogger(__name__)
_debug_lock = threading.Lock()


def _debug_log(entry: dict):
    """Append a debug entry to queue/descripterizer_debug.jsonl if debug mode is on."""
    cfg = get_config()
    if not cfg.descripterizer_debug:
        return
    debug_path = cfg.queue_path / "descripterizer_debug.jsonl"
    debug_path.parent.mkdir(parents=True, exist_ok=True)
    entry["ts"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with _debug_lock:
        with open(debug_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

DESCRIPTERIZER_SYSTEM = """\
You are a code documentation expert. For each code chunk, write a concise 1-2 sentence \
natural language description that would help a developer find this code via search.

Rules:
- Name the key function, class, or method
- Mention specific technologies, libraries, or protocols (e.g. SQLite, React, SSE, Vite)
- Include important parameters, return types, or configuration values when present
- Use terms a developer would type when searching: "proxy API requests", "database connection pool", "email validation"
- 2 sentences, 40-80 words total
- For imports/constants: "Module imports for X" or "Configuration constants for Y"

Examples:
--- Chunk 99 ---
def get_user(db, user_id):
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None

Good: "Function get_user() retrieves a user record from the SQLite database by ID, returning a dictionary or None if not found. Uses parameterized queries for safe database access."

--- Chunk 100 ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

Good: "Express health check endpoint at /api/health that returns JSON with server status and uptime. Useful for monitoring and load balancer health probes."

You will receive multiple chunks, each delimited by --- Chunk {id} ---.
Return ONLY valid JSON — no commentary, no markdown fences:
{
  "descriptions": [
    {"chunk_id": "<the id from the delimiter>", "description": "..."}
  ]
}"""


def _format_batch(chunks: list[tuple]) -> str:
    """Format chunks into a batch prompt.

    Each chunk is (id, text). Uses the same delimiter pattern as the summarizer.
    """
    parts = []
    for chunk_id, text in chunks:
        # Truncate very long chunks to keep prompt reasonable
        truncated = text[:3000] if len(text) > 3000 else text
        parts.append(f"--- Chunk {chunk_id} ---\n{truncated}")
    return "\n\n".join(parts)


def _parse_ollama_backend(backend: str) -> tuple[bool, str | None]:
    """Parse 'ollama' or 'ollama:<model>' → (is_ollama, model_override).

    Returns (True, None) for plain 'ollama' (uses cfg.summarizer_model).
    Returns (True, "ministral-3:8b") for 'ollama:ministral-3:8b'.
    Returns (False, None) for non-ollama backends.
    """
    if backend == "ollama":
        return True, None
    if backend.startswith("ollama:"):
        return True, backend[len("ollama:"):]
    return False, None


def _get_available_backends() -> list[str]:
    """Return list of available backend names for concurrent dispatch."""
    from core.summarizer import _gemini_available, _lmstudio_available

    cfg = get_config()
    backends = []
    if _gemini_available(cfg):
        backends.append("gemini")
    # opencode disabled — too slow / times out for bulk descripterize
    # if _opencode_available(cfg):
    #     backends.append("opencode")
    if _lmstudio_available(cfg):
        backends.append("lmstudio")
    if cfg.summarizer_base_url:
        backends.append("ollama")
    # Anthropic is always available as last resort but don't auto-include
    # (it costs money and is slow for bulk work)
    return backends


def get_active_model_label() -> str:
    """Return a short model label reflecting active descripterizer backends.

    Examples: "flash-lite / gpt-5-mini", "gemini-2.5-flash-lite", "qwen3:8b"
    """
    cfg = get_config()

    if cfg.descripterizer_backends:
        backends = cfg.descripterizer_backends
    else:
        backends = _get_available_backends()

    if not backends:
        return cfg.descripterizer_model or cfg.summarizer_model

    # Map backend name → short model label
    labels = []
    for b in backends:
        if b == "gemini":
            model = cfg.summarizer_gemini_model or "gemini"
            # Shorten "gemini-2.5-flash-lite" → "flash-lite"
            if "flash-lite" in model:
                model = "flash-lite"
            elif "flash" in model:
                model = "flash"
            labels.append(model)
        elif b == "opencode":
            model = cfg.summarizer_opencode_model or "opencode"
            # Shorten "github-copilot/gpt-5-mini" → "gpt-5-mini"
            if "/" in model:
                model = model.rsplit("/", 1)[-1]
            labels.append(model)
        elif b == "lmstudio":
            labels.append(cfg.descripterizer_model or cfg.summarizer_lmstudio_model or "lmstudio")
        elif b == "zai":
            labels.append(cfg.descripterizer_zai_model)
        else:
            is_ollama, model_override = _parse_ollama_backend(b)
            if is_ollama:
                labels.append(model_override or cfg.summarizer_model)
            else:
                labels.append(b)

    return " / ".join(labels)


def get_backend_model_label(backend: str | None) -> str:
    """Return a short model label for a specific backend name."""
    cfg = get_config()
    if backend == "gemini":
        model = cfg.summarizer_gemini_model or "gemini"
        if "flash-lite" in model:
            return "flash-lite"
        if "flash" in model:
            return "flash"
        return model
    if backend == "opencode":
        model = cfg.summarizer_opencode_model or "opencode"
        return model.rsplit("/", 1)[-1] if "/" in model else model
    if backend == "lmstudio":
        return cfg.summarizer_lmstudio_model or "lmstudio"
    if backend == "zai":
        return cfg.descripterizer_zai_model
    if backend:
        is_ollama, model_override = _parse_ollama_backend(backend)
        if is_ollama:
            return model_override or cfg.descripterizer_model or cfg.summarizer_model
    return backend or "unknown"


def _call_llm(prompt: str, *, backend: str | None = None) -> str:
    """Dispatch to a specific or auto-selected LLM backend.

    If backend is specified, uses only that backend (no cascade).
    If backend is None, uses the full cascade: Gemini → OpenCode → LM Studio
    → Ollama → OpenAI-compat → Anthropic.
    """
    from core.summarizer import (
        _gemini_available,
        _lmstudio_available,
        _ollama_api_url,
        _opencode_available,
        _run_gemini,
        _run_opencode,
        _strip_fences,
        _wrap_bare_array,
    )

    cfg = get_config()
    max_tokens = cfg.descripterizer_max_tokens

    # --- Targeted backend ---
    if backend == "gemini" and _gemini_available(cfg):
        text = _run_gemini(cfg, prompt)
        return _wrap_bare_array(_strip_fences(text))

    if backend == "opencode" and _opencode_available(cfg):
        text = _run_opencode(cfg, prompt)
        return _wrap_bare_array(_strip_fences(text))

    if backend == "lmstudio" and _lmstudio_available(cfg):
        import openai

        model = cfg.summarizer_lmstudio_model or "default"
        client = openai.OpenAI(base_url=cfg.summarizer_lmstudio_url, api_key="lm-studio")
        resp = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                {"role": "user", "content": prompt},
            ],
        )
        text = resp.choices[0].message.content or ""
        return _wrap_bare_array(_strip_fences(text))

    if backend is not None:
        is_ollama, model_override = _parse_ollama_backend(backend)
        if is_ollama and cfg.summarizer_base_url:
            import httpx

            ollama_model = model_override or cfg.descripterizer_model or cfg.summarizer_model
            resp = httpx.post(
                _ollama_api_url(cfg),
                json={
                    "model": ollama_model,
                    "stream": False,
                    "think": False,
                    "format": BatchDescriptionResponse.model_json_schema(),
                    "options": {"num_predict": max_tokens},
                    "messages": [
                        {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                        {"role": "user", "content": prompt},
                    ],
                },
                timeout=120.0,
            )
            resp.raise_for_status()
            text = resp.json()["message"]["content"]
            return _wrap_bare_array(_strip_fences(text))

        if backend == "zai":
            import openai

            api_key = os.environ.get("ZAI_API_KEY", "")
            if not api_key:
                raise RuntimeError("ZAI_API_KEY not set")
            client = openai.OpenAI(
                api_key=api_key,
                base_url=cfg.descripterizer_zai_url,
            )
            resp = client.chat.completions.create(
                model=cfg.descripterizer_zai_model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            # Reasoning models may put content in model_extra
            if not text.strip() and hasattr(resp.choices[0].message, "model_extra"):
                extra = resp.choices[0].message.model_extra or {}
                text = extra.get("reasoning_content", "")
            text = _strip_fences(text)
            # GLM models sometimes prefix JSON with narrative text — extract the JSON
            if text and not text.lstrip().startswith("{"):
                idx = text.find("{")
                if idx >= 0:
                    text = text[idx:]
            return _wrap_bare_array(text)

        # Requested backend not available
        raise RuntimeError(f"Backend '{backend}' not available")

    # --- Full cascade (no backend specified) ---
    if _gemini_available(cfg):
        try:
            text = _run_gemini(cfg, prompt)
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("Gemini CLI descripterizer failed", exc_info=True)

    # opencode disabled — too slow / times out for bulk descripterize
    # if _opencode_available(cfg):
    #     try:
    #         text = _run_opencode(cfg, prompt)
    #         return _wrap_bare_array(_strip_fences(text))
    #     except Exception:
    #         logger.debug("OpenCode CLI descripterizer failed", exc_info=True)

    if _lmstudio_available(cfg):
        try:
            import openai

            model = cfg.summarizer_lmstudio_model or "default"
            client = openai.OpenAI(base_url=cfg.summarizer_lmstudio_url, api_key="lm-studio")
            resp = client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("LM Studio descripterizer failed", exc_info=True)

    if cfg.summarizer_base_url:
        try:
            import httpx

            resp = httpx.post(
                _ollama_api_url(cfg),
                json={
                    "model": cfg.descripterizer_model or cfg.summarizer_model,
                    "stream": False,
                    "think": False,
                    "format": BatchDescriptionResponse.model_json_schema(),
                    "options": {"num_predict": max_tokens},
                    "messages": [
                        {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                        {"role": "user", "content": prompt},
                    ],
                },
                timeout=120.0,
            )
            resp.raise_for_status()
            text = resp.json()["message"]["content"]
            if text and text.strip():
                return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("Ollama native descripterizer failed", exc_info=True)

        try:
            import openai

            model = cfg.descripterizer_fallback_model or cfg.summarizer_fallback_model or cfg.descripterizer_model or cfg.summarizer_model
            client = openai.OpenAI(base_url=cfg.summarizer_base_url, api_key="ollama")
            resp = client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
            )
            text = resp.choices[0].message.content or ""
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("OpenAI-compat descripterizer failed", exc_info=True)

    import anthropic

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=cfg.summarizer_model,
        max_tokens=max_tokens,
        system=DESCRIPTERIZER_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text
    return _wrap_bare_array(_strip_fences(text))


def _describe_batch(chunks: list[tuple], *, backend: str | None = None) -> BatchDescriptionResponse:
    """Generate descriptions for a batch of (chunk_id, text) tuples."""
    user_content = _format_batch(chunks)
    chunk_ids = [c[0] for c in chunks]
    try:
        raw = _call_llm(DESCRIPTERIZER_SYSTEM + "\n\n" + user_content, backend=backend)
        resp = BatchDescriptionResponse.model_validate_json(raw)
        # Build before/after pairs for quality comparison
        code_map = {cid: text for cid, text in chunks}
        pairs = []
        for d in resp.descriptions:
            pairs.append({
                "chunk_id": d.chunk_id,
                "code": code_map.get(d.chunk_id, "")[:500],
                "description": d.description,
            })
        _debug_log({
            "event": "batch_ok",
            "backend": backend,
            "chunk_ids": chunk_ids,
            "descriptions": pairs,
            "raw_response": raw[:2000],
        })
        return resp
    except Exception as exc:
        # Log the input chunks so we can see what failed
        input_preview = [{
            "chunk_id": cid,
            "code": text[:300],
        } for cid, text in chunks]
        _debug_log({
            "event": "batch_fail",
            "backend": backend,
            "chunk_ids": chunk_ids,
            "input_preview": input_preview,
            "error": f"{type(exc).__name__}: {exc}",
        })
        raise


def descripterize_project(
    project: str,
    *,
    db_path=None,
    force: bool = False,
    on_batch=None,
    backend_filter: list[str] | None = None,
) -> dict:
    """Generate NL descriptions for undescribed chunks and re-embed them.

    Args:
        project: Project name (chunks are filtered by file_path LIKE '{project}/%').
        db_path: Path to code.db (defaults to config).
        force: If True, re-describe all chunks (not just undescribed ones).
        on_batch: Optional callback(batch_described, batch_failed, total_described,
                  total_failed, total) called after each batch completes.
        backend_filter: If set, override configured backends with this list.

    Returns:
        Stats dict with keys: described, failed, skipped, total.
    """
    from core.db_writer import get_writer
    from core.indexing_utils import _get_embeddings_batch, _save_embedding_cache

    cfg = get_config()
    if db_path is None:
        db_path = cfg.code_db_path

    # All DB writes go through the single-writer queue; reads use WAL readers
    writer = get_writer(db_path)
    path_filter = f"{project}/%"

    # Query chunks needing descriptions via a read-only connection
    reader = writer.get_reader()
    try:
        if force:
            rows = reader.execute(
                "SELECT id, text FROM chunks WHERE file_path LIKE ?",
                (path_filter,),
            ).fetchall()
        else:
            rows = reader.execute(
                "SELECT id, text FROM chunks WHERE file_path LIKE ? AND description IS NULL",
                (path_filter,),
            ).fetchall()
    finally:
        reader.close()

    total = len(rows)
    if total == 0:
        return {"described": 0, "failed": 0, "skipped": 0, "total": 0}

    batch_size = cfg.descripterizer_batch_size
    concurrency = cfg.descripterizer_concurrency
    described = 0
    failed = 0
    backends_used: dict[str, int] = {}  # backend -> chunks described
    _counter_lock = threading.Lock()

    # Load .env for API keys (ZAI_API_KEY etc.)
    env_path = cfg.byomem / ".env" if (cfg.byomem / ".env").exists() else None
    if not env_path:
        # Also check source repo .env
        import pathlib
        src_env = pathlib.Path(__file__).resolve().parent.parent / ".env"
        if src_env.exists():
            env_path = src_env
    if env_path:
        with open(env_path) as _ef:
            for _line in _ef:
                _line = _line.strip()
                if _line and "=" in _line and not _line.startswith("#"):
                    _k, _v = _line.split("=", 1)
                    os.environ.setdefault(_k.strip(), _v.strip())

    # Detect available backends for multi-backend concurrency
    # Cloud backends activated only for large jobs (above threshold)
    # zai is fast enough (~5-10s) to be always-on alongside local models
    cloud_backends = {"gemini"}  # opencode disabled

    if backend_filter is not None:
        # CLI override — use exactly what was requested, skip tiering
        backends = backend_filter
        logger.info("Backend filter active — using: %s", backends)
    elif cfg.descripterizer_backends:
        all_backends = cfg.descripterizer_backends
        # Tiered: only include cloud backends when chunk count exceeds threshold
        threshold = cfg.descripterizer_cloud_threshold
        if total >= threshold:
            backends = all_backends
            logger.info(
                "Large job (%d chunks >= %d threshold) — using all backends: %s",
                total, threshold, backends,
            )
        else:
            backends = [b for b in all_backends if b not in cloud_backends]
            if not backends:
                backends = all_backends
            logger.info(
                "Small job (%d chunks < %d threshold) — local backends only: %s",
                total, threshold, backends,
            )
    else:
        backends = _get_available_backends()
        logger.info("Auto-detected backends: %s", backends)

    if not backends:
        backends = [None]  # fall back to cascade
    else:
        # Scale concurrency: N workers per backend (default 4 per backend)
        workers_per_backend = max(concurrency, 4)
        concurrency = len(backends) * workers_per_backend
        logger.info(
            "Descripterizer backends: %s (%d workers each, %d total)",
            backends, workers_per_backend, concurrency,
        )

    # Per-backend failure tracking: 5 fails → 5min cooldown, 3 cooldowns → disabled
    import queue as _queue
    import time as _time

    max_failures = cfg.descripterizer_max_failures  # consecutive fails before cooldown
    max_cooldowns = 3  # cooldowns before permanent disable
    backoff_seconds = 300  # 5 minutes
    backend_failures: dict[str, int] = {b: 0 for b in backends if b}
    backend_cooldowns: dict[str, int] = {b: 0 for b in backends if b}
    backend_cooldown_until: dict[str, float] = {}
    disabled_backends: set[str] = set()
    health_lock = threading.Lock()  # protects failure/cooldown/disabled state

    def _is_backend_available(backend: str | None) -> bool:
        """Check if a backend is available (not disabled or in cooldown)."""
        if backend is None:
            return True  # cascade mode — always available
        if backend in disabled_backends:
            return False
        if backend in backend_cooldown_until:
            if _time.monotonic() < backend_cooldown_until[backend]:
                return False
            # Cooldown expired — re-enable
            with health_lock:
                if backend in backend_cooldown_until:
                    del backend_cooldown_until[backend]
                    backend_failures[backend] = 0
                    print(
                        f"  >>> Backend '{backend}' re-enabled after cooldown "
                        f"({backend_cooldowns.get(backend, 0)}/{max_cooldowns})",
                        file=sys.stderr,
                    )
        return True

    def _record_failure(backend: str | None):
        """Track a backend failure; apply cooldown/disable as needed."""
        if backend is None:
            return
        with health_lock:
            if backend not in backend_failures:
                return
            backend_failures[backend] += 1
            if backend_failures[backend] >= max_failures and backend not in backend_cooldown_until:
                backend_cooldowns[backend] = backend_cooldowns.get(backend, 0) + 1
                if backend_cooldowns[backend] >= max_cooldowns:
                    disabled_backends.add(backend)
                    active = [b for b in backends if b not in disabled_backends]
                    print(
                        f"  *** Backend '{backend}' DISABLED after "
                        f"{max_cooldowns} cooldowns. Active: {active or ['none']}",
                        file=sys.stderr,
                    )
                    _debug_log({
                        "event": "backend_disabled",
                        "backend": backend,
                        "cooldowns": backend_cooldowns[backend],
                        "remaining": active,
                    })
                else:
                    backend_cooldown_until[backend] = _time.monotonic() + backoff_seconds
                    active = [b for b in backends if b not in disabled_backends and b not in backend_cooldown_until]
                    print(
                        f"  *** Backend '{backend}' paused {backoff_seconds}s "
                        f"(cooldown {backend_cooldowns[backend]}/{max_cooldowns}). "
                        f"Active: {active or ['none']}",
                        file=sys.stderr,
                    )
                    _debug_log({
                        "event": "backend_cooldown",
                        "backend": backend,
                        "failures": backend_failures[backend],
                        "cooldown_num": backend_cooldowns[backend],
                        "cooldown_s": backoff_seconds,
                        "remaining": active,
                    })

    def _record_success(backend: str | None):
        """Reset consecutive failure count on success."""
        if backend is None:
            return
        with health_lock:
            if backend in backend_failures:
                backend_failures[backend] = 0

    def _backend_order(preferred: str | None) -> list[str | None]:
        """Return backends to try: preferred first, then all others as fallback."""
        order: list[str | None] = [preferred]
        for b in backends:
            if b != preferred and b not in order:
                order.append(b)
        return order

    # Build work queue — batches are NOT pre-assigned to backends
    work_q: _queue.Queue = _queue.Queue()
    batch_idx = 0
    for i in range(0, total, batch_size):
        batch_rows = rows[i : i + batch_size]
        batch_chunks = [(str(row[0]), row[1]) for row in batch_rows]
        work_q.put((batch_idx, batch_chunks))
        batch_idx += 1

    def _store_results(batch_chunks, resp, backend=None):
        """Write descriptions + embeddings to DB. Returns count described."""
        desc_map = {d.chunk_id: d.description for d in resp.descriptions}

        to_embed = []
        for chunk_id_str, _ in batch_chunks:
            desc = desc_map.get(chunk_id_str)
            if desc:
                to_embed.append((int(chunk_id_str), desc))

        if not to_embed:
            return 0

        desc_texts = [d for _, d in to_embed]
        desc_hashes = [hashlib.sha256(d.encode()).hexdigest() for d in desc_texts]

        # Embedding cache lookups are read-only — use a WAL reader
        rd = writer.get_reader()
        try:
            embed_results = _get_embeddings_batch(
                rd, desc_texts, desc_hashes, model=cfg.code_embedding_model
            )
        finally:
            rd.close()

        # Write all results atomically through the single-writer queue
        def _write_fn(conn):
            for j, (chunk_id, desc) in enumerate(to_embed):
                embedding, is_new = embed_results[j]
                conn.execute(
                    "UPDATE chunks SET description = ? WHERE id = ?",
                    (desc, chunk_id),
                )
                if embedding is not None:
                    try:
                        import sqlite_vec

                        conn.execute("DELETE FROM chunks_vec WHERE rowid = ?", (chunk_id,))
                        conn.execute(
                            "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
                            (chunk_id, sqlite_vec.serialize_float32(embedding)),
                        )
                    except Exception:
                        pass
                    if is_new:
                        _save_embedding_cache(conn, desc_hashes[j], embedding)
            conn.commit()
            return len(to_embed)

        return writer.submit(_write_fn)

    def _worker(preferred_backend: str | None):
        """Pull batches from queue, try preferred backend then fallback to others."""
        nonlocal described, failed

        while True:
            try:
                bid, batch_chunks = work_q.get_nowait()
            except _queue.Empty:
                return

            # Try backends in order: preferred first, then others
            order = _backend_order(preferred_backend)
            success = False
            attempts = []

            for backend in order:
                if not _is_backend_available(backend):
                    continue

                try:
                    resp = _describe_batch(batch_chunks, backend=backend)
                except Exception as exc:
                    attempts.append((backend, str(exc)[:80]))
                    logger.warning("Batch %d failed (%s): %s", bid, backend, exc)
                    _record_failure(backend)
                    continue

                # Success — store results
                _record_success(backend)
                n = _store_results(batch_chunks, resp, backend)

                with _counter_lock:
                    if n > 0:
                        described += n
                        if backend:
                            backends_used[backend] = backends_used.get(backend, 0) + n
                    else:
                        failed += len(batch_chunks)
                    if on_batch:
                        on_batch(n, 0 if n else len(batch_chunks), described, failed, total, backend=backend)
                    print(
                        f"  [{min(described + failed, total)}/{total}] "
                        f"{described} described, {failed} failed",
                        file=sys.stderr,
                    )

                success = True
                break

            if not success:
                # All backends failed for this batch
                with _counter_lock:
                    failed += len(batch_chunks)
                    if on_batch:
                        on_batch(0, len(batch_chunks), described, failed, total, backend=None)
                    backends_tried = ", ".join(str(b) for b, _ in attempts) or "none"
                    print(
                        f"  [{min(described + failed, total)}/{total}] "
                        f"{described} described, {failed} failed "
                        f"(batch {bid} exhausted all backends: {backends_tried})",
                        file=sys.stderr,
                    )
                _debug_log({
                    "event": "batch_exhausted",
                    "batch_idx": bid,
                    "chunk_ids": [c[0] for c in batch_chunks],
                    "attempts": [{"backend": b, "error": e} for b, e in attempts],
                })

            work_q.task_done()

    if concurrency <= 1 or not backends or backends == [None]:
        # Single-threaded fallback — worker pulls from queue itself
        _worker(backends[0] if backends else None)
    else:
        # Spawn workers: distribute across backends, each pulls from shared queue
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="desc") as pool:
            futures = []
            for i in range(concurrency):
                preferred = backends[i % len(backends)]
                futures.append(pool.submit(_worker, preferred))
            for f in futures:
                f.result()

    # Report backend health at end of run
    for b in backends:
        if b and (b in disabled_backends or backend_cooldowns.get(b, 0) > 0):
            status = "DISABLED" if b in disabled_backends else f"{backend_cooldowns[b]}/{max_cooldowns} cooldowns"
            print(f"  Backend '{b}': {status}", file=sys.stderr)

    # Build model label from backends that actually processed chunks
    if backends_used:
        labels = [f"{get_backend_model_label(b)}({n})" for b, n in backends_used.items()]
        desc_model = " / ".join(labels)
    else:
        desc_model = get_active_model_label()

    return {
        "described": described,
        "failed": failed,
        "skipped": total - described - failed,
        "total": total,
        "desc_model": desc_model,
    }
