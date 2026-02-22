"""Shared embedding and chunking helpers for search_index and code_index."""

import struct

import openai

from core.config import get_config


def _fetch_embedding(db, text, text_hash):
    """Check cache then API. Returns (embedding, is_new) without writing to DB.

    On cache hit:    returns (embedding_list, False)
    On API success:  returns (embedding_list, True)
    On API failure:  returns (None, False)
    """
    row = db.execute(
        "SELECT embedding FROM embedding_cache WHERE text_hash=?", (text_hash,)
    ).fetchone()
    if row:
        blob = row[0]
        return list(struct.unpack(f"{len(blob) // 4}f", blob)), False
    try:
        cfg = get_config()
        client_kwargs = {}
        if cfg.embedding_base_url:
            client_kwargs["base_url"] = cfg.embedding_base_url
            client_kwargs["api_key"] = "ollama"
        resp = openai.OpenAI(**client_kwargs).embeddings.create(
            model=cfg.embedding_model, input=text
        )
        embedding = resp.data[0].embedding
        return embedding, True
    except Exception:
        return None, False


def _save_embedding_cache(db, text_hash, embedding):
    """Write an embedding to the embedding_cache table."""
    blob = struct.pack(f"{len(embedding)}f", *embedding)
    db.execute(
        "INSERT OR REPLACE INTO embedding_cache (text_hash, embedding) VALUES (?, ?)",
        (text_hash, blob),
    )


def _get_embedding(db, text, text_hash):
    """Return cached embedding or generate via OpenAI. Returns None on failure.

    Backward-compat wrapper around _fetch_embedding + _save_embedding_cache.
    """
    embedding, is_new = _fetch_embedding(db, text, text_hash)
    if is_new and embedding is not None:
        _save_embedding_cache(db, text_hash, embedding)
    return embedding


def _get_embeddings_batch(db, texts, text_hashes, batch_size=20):
    """Batch-fetch embeddings with cache lookup and batched API calls.

    Returns a list of (embedding, is_new) tuples in the same order as inputs.
    Does NOT write to the DB — cache writes are deferred to Phase 2 transaction.

    On cache hit:    (embedding_list, False)
    On API success:  (embedding_list, True)
    On API failure:  (None, False)
    """
    if not texts:
        return []

    n = len(texts)
    results = [None] * n  # will hold (embedding, is_new) tuples

    # Phase 1: batch cache lookup
    uncached_indices = []
    uncached_texts = []
    for i in range(n):
        row = db.execute(
            "SELECT embedding FROM embedding_cache WHERE text_hash=?",
            (text_hashes[i],),
        ).fetchone()
        if row:
            blob = row[0]
            embedding = list(struct.unpack(f"{len(blob) // 4}f", blob))
            results[i] = (embedding, False)
        else:
            uncached_indices.append(i)
            uncached_texts.append(texts[i])

    # Phase 2: batched API calls for uncached texts
    if uncached_texts:
        try:
            cfg = get_config()
            client_kwargs = {}
            if cfg.embedding_base_url:
                client_kwargs["base_url"] = cfg.embedding_base_url
                client_kwargs["api_key"] = "ollama"
            client = openai.OpenAI(**client_kwargs)
        except Exception:
            # Client construction failed — mark all uncached as failed
            for i in uncached_indices:
                results[i] = (None, False)
            return results

        for batch_start in range(0, len(uncached_texts), batch_size):
            batch_end = batch_start + batch_size
            batch_texts = uncached_texts[batch_start:batch_end]
            batch_indices = uncached_indices[batch_start:batch_end]
            try:
                resp = client.embeddings.create(
                    model=cfg.embedding_model, input=batch_texts
                )
                for j, idx in enumerate(batch_indices):
                    results[idx] = (resp.data[j].embedding, True)
            except Exception:
                for idx in batch_indices:
                    results[idx] = (None, False)

    return results


def _chunk_text(text, chunk_tokens, chunk_overlap, chars_per_token=4):
    """Line-based chunking with overlap. ~4 chars per token approximation."""
    lines = text.splitlines()
    chunks = []
    i = 0
    chunk_chars = chunk_tokens * chars_per_token
    overlap_chars = chunk_overlap * chars_per_token

    while i < len(lines):
        chunk_lines = []
        char_count = 0
        j = i
        while j < len(lines) and char_count < chunk_chars:
            chunk_lines.append(lines[j])
            char_count += len(lines[j])
            j += 1

        if chunk_lines:
            chunks.append((i + 1, j, "\n".join(chunk_lines)))

        # If we consumed all remaining lines, we're done
        if j >= len(lines):
            break

        # Walk back from j to find overlap start
        next_start = j
        overlap_so_far = 0
        while next_start > i and overlap_so_far < overlap_chars:
            next_start -= 1
            overlap_so_far += len(lines[next_start])
        i = max(i + 1, next_start)

    return chunks
