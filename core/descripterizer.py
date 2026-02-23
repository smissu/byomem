"""Generate natural language descriptions for code chunks and re-embed them.

Runs as a second pass after indexing: queries chunks without descriptions,
batches them through the summarizer LLM, stores descriptions, and re-embeds
using description text for better semantic search.
"""

import hashlib
import logging
import sys

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


def _call_llm(prompt: str) -> str:
    """Dispatch to the configured LLM backend using the summarizer cascade.

    Returns raw response text. Reuses the same backend priority as the summarizer:
    1. Gemini CLI  2. OpenCode CLI  3. LM Studio  4. Ollama native
    5. OpenAI-compat  6. Anthropic
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

    # 1. Gemini CLI
    if _gemini_available(cfg):
        try:
            text = _run_gemini(cfg, prompt)
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("Gemini CLI descripterizer failed", exc_info=True)

    # 2. OpenCode CLI
    if _opencode_available(cfg):
        try:
            text = _run_opencode(cfg, prompt)
            return _wrap_bare_array(_strip_fences(text))
        except Exception:
            logger.debug("OpenCode CLI descripterizer failed", exc_info=True)

    # 3. LM Studio
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

    # 4/5. Ollama native / OpenAI-compat
    if cfg.summarizer_base_url:
        # Try native Ollama first
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

        # OpenAI-compat fallback
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

    # 6. Anthropic
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


def _describe_batch(chunks: list[tuple]) -> BatchDescriptionResponse:
    """Generate descriptions for a batch of (chunk_id, text) tuples."""
    user_content = _format_batch(chunks)
    # _call_llm handles system prompt internally for structured backends;
    # for CLI backends (Gemini, OpenCode), we prepend it to the prompt
    raw = _call_llm(DESCRIPTERIZER_SYSTEM + "\n\n" + user_content)
    return BatchDescriptionResponse.model_validate_json(raw)


def descripterize_project(
    project: str,
    *,
    db_path=None,
    force: bool = False,
) -> dict:
    """Generate NL descriptions for undescribed chunks and re-embed them.

    Args:
        project: Project name (chunks are filtered by file_path LIKE '{project}/%').
        db_path: Path to code.db (defaults to config).
        force: If True, re-describe all chunks (not just undescribed ones).

    Returns:
        Stats dict with keys: described, failed, skipped, total.
    """
    from core.code_index import get_code_db
    from core.indexing_utils import _get_embeddings_batch, _save_embedding_cache

    cfg = get_config()
    if db_path is None:
        db_path = cfg.code_db_path

    db = get_code_db(db_path)
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
    described = 0
    failed = 0

    # Process in batches
    for i in range(0, total, batch_size):
        batch_rows = rows[i : i + batch_size]
        batch_chunks = [(str(row[0]), row[1]) for row in batch_rows]

        try:
            resp = _describe_batch(batch_chunks)
        except Exception as exc:
            logger.warning("Batch %d-%d failed: %s", i, i + len(batch_rows), exc)
            failed += len(batch_rows)
            continue

        # Map descriptions by chunk_id
        desc_map = {d.chunk_id: d.description for d in resp.descriptions}

        # Collect descriptions and their hashes for batch embedding
        to_embed = []  # (chunk_id, description)
        for chunk_id_str, _ in batch_chunks:
            desc = desc_map.get(chunk_id_str)
            if desc:
                to_embed.append((int(chunk_id_str), desc))

        if not to_embed:
            failed += len(batch_rows)
            continue

        # Batch embed descriptions
        desc_texts = [d for _, d in to_embed]
        desc_hashes = [hashlib.sha256(d.encode()).hexdigest() for d in desc_texts]

        embed_results = _get_embeddings_batch(
            db, desc_texts, desc_hashes, model=cfg.code_embedding_model
        )

        # Apply: store description + re-embed
        for j, (chunk_id, desc) in enumerate(to_embed):
            embedding, is_new = embed_results[j]

            # Store description
            db.execute(
                "UPDATE chunks SET description = ? WHERE id = ?",
                (desc, chunk_id),
            )

            # Re-embed with description vector
            if embedding is not None:
                try:
                    import sqlite_vec

                    # Delete old vec entry and insert new one
                    db.execute("DELETE FROM chunks_vec WHERE rowid = ?", (chunk_id,))
                    db.execute(
                        "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
                        (chunk_id, sqlite_vec.serialize_float32(embedding)),
                    )
                except Exception:
                    pass

                # Cache embedding
                if is_new:
                    _save_embedding_cache(db, desc_hashes[j], embedding)

            described += 1

        db.commit()

        print(
            f"  [{min(i + batch_size, total)}/{total}] "
            f"{described} described, {failed} failed",
            file=sys.stderr,
        )

    db.close()
    return {
        "described": described,
        "failed": failed,
        "skipped": total - described - failed,
        "total": total,
    }
