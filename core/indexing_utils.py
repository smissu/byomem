"""Shared embedding and chunking helpers for search_index and code_index."""

import struct

import openai

from core.config import get_config


def _get_embedding(db, text, text_hash):
    """Return cached embedding or generate via OpenAI. Returns None on failure."""
    row = db.execute(
        "SELECT embedding FROM embedding_cache WHERE text_hash=?", (text_hash,)
    ).fetchone()
    if row:
        blob = row[0]
        return list(struct.unpack(f"{len(blob) // 4}f", blob))
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
        import sqlite_vec

        db.execute(
            "INSERT INTO embedding_cache (text_hash, embedding) VALUES (?,?)",
            (text_hash, sqlite_vec.serialize_float32(embedding)),
        )
        return embedding
    except Exception:
        return None


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
