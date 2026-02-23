"""Generate natural language descriptions for code chunks and re-embed them.

Runs as a second pass after indexing: queries chunks without descriptions,
batches them through the summarizer LLM, stores descriptions, and re-embeds
using description text for better semantic search.
"""

import hashlib
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from core.config import get_config
from core.models import BatchDescriptionResponse

logger = logging.getLogger(__name__)

DESCRIPTERIZER_SYSTEM = """\
You are a code documentation expert. For each code chunk, write a concise \
1-2 sentence natural language description of what the code does.

Rules:
- Focus on WHAT the code does and WHY, not HOW
- Use natural language a developer would use when searching for this code
- Include key function/class/method names
- 1-2 sentences, 30-60 words each
- For imports/constants: "Module imports for X" or "Constants for Y"

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


def _get_available_backends() -> list[str]:
    """Return list of available backend names for concurrent dispatch."""
    from core.summarizer import _gemini_available, _lmstudio_available, _opencode_available

    cfg = get_config()
    backends = []
    if _gemini_available(cfg):
        backends.append("gemini")
    if _opencode_available(cfg):
        backends.append("opencode")
    if _lmstudio_available(cfg):
        backends.append("lmstudio")
    if cfg.summarizer_base_url:
        backends.append("ollama")
    # Anthropic is always available as last resort but don't auto-include
    # (it costs money and is slow for bulk work)
    return backends


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
            max_tokens=cfg.summarizer_max_tokens,
            messages=[
                {"role": "system", "content": DESCRIPTERIZER_SYSTEM},
                {"role": "user", "content": prompt},
            ],
        )
        text = resp.choices[0].message.content or ""
        return _wrap_bare_array(_strip_fences(text))

    if backend == "ollama" and cfg.summarizer_base_url:
        import httpx

        resp = httpx.post(
            _ollama_api_url(cfg),
            json={
                "model": cfg.summarizer_model,
                "stream": False,
                "think": False,
                "format": BatchDescriptionResponse.model_json_schema(),
                "options": {"num_predict": cfg.summarizer_max_tokens},
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

    # If a specific backend was requested but we got here, it wasn't available
    if backend is not None:
        raise RuntimeError(f"Backend '{backend}' not available")

    # --- Full cascade (no backend specified) ---
    if _gemini_available(cfg):
        try:
            text = _run_gemini(cfg, prompt)
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("Gemini CLI descripterizer failed", exc_info=True)

    if _opencode_available(cfg):
        try:
            text = _run_opencode(cfg, prompt)
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("OpenCode CLI descripterizer failed", exc_info=True)

    if _lmstudio_available(cfg):
        try:
            import openai

            model = cfg.summarizer_lmstudio_model or "default"
            client = openai.OpenAI(base_url=cfg.summarizer_lmstudio_url, api_key="lm-studio")
            resp = client.chat.completions.create(
                model=model,
                max_tokens=cfg.summarizer_max_tokens,
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
                    "model": cfg.summarizer_model,
                    "stream": False,
                    "think": False,
                    "format": BatchDescriptionResponse.model_json_schema(),
                    "options": {"num_predict": cfg.summarizer_max_tokens},
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

            model = cfg.summarizer_fallback_model or cfg.summarizer_model
            client = openai.OpenAI(base_url=cfg.summarizer_base_url, api_key="ollama")
            resp = client.chat.completions.create(
                model=model,
                max_tokens=cfg.summarizer_max_tokens,
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
        max_tokens=cfg.summarizer_max_tokens,
        system=DESCRIPTERIZER_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    text = resp.content[0].text
    return _wrap_bare_array(_strip_fences(text))


def _describe_batch(chunks: list[tuple], *, backend: str | None = None) -> BatchDescriptionResponse:
    """Generate descriptions for a batch of (chunk_id, text) tuples."""
    user_content = _format_batch(chunks)
    raw = _call_llm(DESCRIPTERIZER_SYSTEM + "\n\n" + user_content, backend=backend)
    return BatchDescriptionResponse.model_validate_json(raw)


def descripterize_project(
    project: str,
    *,
    db_path=None,
    force: bool = False,
    on_batch=None,
) -> dict:
    """Generate NL descriptions for undescribed chunks and re-embed them.

    Args:
        project: Project name (chunks are filtered by file_path LIKE '{project}/%').
        db_path: Path to code.db (defaults to config).
        force: If True, re-describe all chunks (not just undescribed ones).
        on_batch: Optional callback(batch_described, batch_failed, total_described,
                  total_failed, total) called after each batch completes.

    Returns:
        Stats dict with keys: described, failed, skipped, total.
    """
    from core.code_index import get_code_db
    from core.indexing_utils import _get_embeddings_batch, _save_embedding_cache

    cfg = get_config()
    if db_path is None:
        db_path = cfg.code_db_path

    # check_same_thread=False is safe because all DB access is serialized
    # behind db_lock when concurrency > 1
    db = get_code_db(db_path, check_same_thread=False)
    path_filter = f"{project}/%"

    # Query chunks needing descriptions
    if force:
        rows = db.execute(
            "SELECT id, text FROM chunks WHERE file_path LIKE ?",
            (path_filter,),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, text FROM chunks WHERE file_path LIKE ? AND description IS NULL",
            (path_filter,),
        ).fetchall()

    total = len(rows)
    if total == 0:
        db.close()
        return {"described": 0, "failed": 0, "skipped": 0, "total": 0}

    batch_size = cfg.descripterizer_batch_size
    concurrency = cfg.descripterizer_concurrency
    described = 0
    failed = 0
    db_lock = threading.Lock()

    # Detect available backends for multi-backend concurrency
    if cfg.descripterizer_backends:
        # Use explicitly configured backends
        backends = cfg.descripterizer_backends
    else:
        backends = _get_available_backends()

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

    # Build all batches upfront, round-robin assign backends
    all_batches = []
    for i in range(0, total, batch_size):
        batch_rows = rows[i : i + batch_size]
        batch_chunks = [(str(row[0]), row[1]) for row in batch_rows]
        backend = backends[len(all_batches) % len(backends)]
        all_batches.append((i, batch_chunks, backend))

    def _process_one_batch(batch_idx, batch_chunks, backend=None):
        """LLM call + embed + DB write for one batch. Thread-safe."""
        nonlocal described, failed

        # LLM call (the slow part — runs concurrently)
        try:
            resp = _describe_batch(batch_chunks, backend=backend)
        except Exception as exc:
            logger.warning("Batch %d failed: %s", batch_idx, exc)
            with db_lock:
                failed += len(batch_chunks)
                if on_batch:
                    on_batch(0, len(batch_chunks), described, failed, total)
            return

        desc_map = {d.chunk_id: d.description for d in resp.descriptions}

        to_embed = []
        for chunk_id_str, _ in batch_chunks:
            desc = desc_map.get(chunk_id_str)
            if desc:
                to_embed.append((int(chunk_id_str), desc))

        if not to_embed:
            with db_lock:
                failed += len(batch_chunks)
            return

        # Embed descriptions
        desc_texts = [d for _, d in to_embed]
        desc_hashes = [hashlib.sha256(d.encode()).hexdigest() for d in desc_texts]

        with db_lock:
            embed_results = _get_embeddings_batch(
                db, desc_texts, desc_hashes, model=cfg.code_embedding_model
            )

            for j, (chunk_id, desc) in enumerate(to_embed):
                embedding, is_new = embed_results[j]

                db.execute(
                    "UPDATE chunks SET description = ? WHERE id = ?",
                    (desc, chunk_id),
                )

                if embedding is not None:
                    try:
                        import sqlite_vec

                        db.execute("DELETE FROM chunks_vec WHERE rowid = ?", (chunk_id,))
                        db.execute(
                            "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
                            (chunk_id, sqlite_vec.serialize_float32(embedding)),
                        )
                    except Exception:
                        pass

                    if is_new:
                        _save_embedding_cache(db, desc_hashes[j], embedding)

                described += 1

            db.commit()

            batch_described = len(to_embed)
            if on_batch:
                on_batch(batch_described, 0, described, failed, total)

            print(
                f"  [{min(described + failed, total)}/{total}] "
                f"{described} described, {failed} failed",
                file=sys.stderr,
            )

    if concurrency <= 1:
        for batch_idx, batch_chunks, backend in all_batches:
            _process_one_batch(batch_idx, batch_chunks, backend)
    else:
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="desc") as pool:
            futures = {
                pool.submit(_process_one_batch, batch_idx, batch_chunks, backend): batch_idx
                for batch_idx, batch_chunks, backend in all_batches
            }
            for future in as_completed(futures):
                future.result()  # propagate exceptions

    db.close()
    return {
        "described": described,
        "failed": failed,
        "skipped": total - described - failed,
        "total": total,
    }
