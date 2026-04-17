"""Hybrid search index: SQLite FTS5 (BM25) + sqlite-vec (cosine)."""

import hashlib
import sqlite3
import time
from pathlib import Path

from core.config import get_config
from core.db_writer import get_writer
from core.indexing_utils import (
    _chunk_text,
    _get_embedding,
    _get_embeddings_batch,
    _save_embedding_cache,
)


def _search_schema_init(conn: sqlite3.Connection) -> None:
    """Schema init for search.db (differs from code.db — no meta/description)."""
    cfg = get_config()
    dim = cfg.embedding_dimension
    vec_available = False
    try:
        import sqlite_vec  # noqa: F401

        vec_available = True
    except Exception:
        pass

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, content_hash TEXT, modified_at REAL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY, file_path TEXT,
            start_line INTEGER, end_line INTEGER, text TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(text, content=chunks, content_rowid=id);
        CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT PRIMARY KEY, embedding BLOB
        );
    """
    )
    if vec_available:
        try:
            conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec "
                f"USING vec0(embedding FLOAT[{dim}])"
            )
        except Exception:
            pass
    conn.commit()


def _get_search_writer(db_path=None):
    """Get the singleton writer for search.db."""
    cfg = get_config()
    path = db_path or cfg.db_path
    return get_writer(path, schema_init=_search_schema_init)


def get_db(db_path=None):
    """Connect to search DB, load sqlite-vec, and initialise schema.

    Kept for backward compatibility. New code should use _get_search_writer().
    """
    cfg = get_config()
    path = db_path or cfg.db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    vec_available = False
    try:
        import sqlite_vec

        db.enable_load_extension(True)
        sqlite_vec.load(db)
        db.enable_load_extension(False)
        vec_available = True
    except Exception:
        pass
    _init_schema(db, cfg.embedding_dimension, vec_available)
    return db


def index_file(path: Path, project: str):
    """Chunk, embed, and upsert a file into the search index.

    Two-phase design to minimise SQLite write-lock hold time:
      Phase 1 (GATHER) — read file, chunk, fetch embeddings (slow API calls)
                         using a read-only connection.
      Phase 2 (WRITE)  — DELETE old + INSERT new via the single writer thread.
    No embedding API calls occur between DELETE and COMMIT.
    """
    cfg = get_config()
    rel_path = str(path.relative_to(cfg.byomem))
    content = path.read_text()
    h = hashlib.sha256(content.encode()).hexdigest()

    writer = _get_search_writer()

    # ── Phase 1: GATHER (read-only) ──────────────────────────
    reader = writer.get_reader()
    try:
        # Quick read-only check: skip if content unchanged
        row = reader.execute(
            "SELECT content_hash FROM files WHERE path=?", (rel_path,)
        ).fetchone()
        if row and row[0] == h:
            return  # unchanged

        # Chunk the content
        chunks = _chunk_structured(content, rel_path, cfg)

        # Compute text hashes and collect texts for batch embedding
        texts = []
        text_hashes = []
        for start_line, end_line, text in chunks:
            text_hash = hashlib.sha256(text.encode()).hexdigest()
            texts.append(text)
            text_hashes.append(text_hash)

        # Batch-fetch all embeddings (reads cache, calls API for misses — no DB writes)
        embed_results = _get_embeddings_batch(reader, texts, text_hashes)
    finally:
        reader.close()

    # Build gathered tuples: (start_line, end_line, text, text_hash, embedding, is_new)
    gathered = []
    for i, (start_line, end_line, text) in enumerate(chunks):
        embedding, is_new = embed_results[i]
        gathered.append((start_line, end_line, text, text_hashes[i], embedding, is_new))

    # ── Phase 2: WRITE (via single writer thread) ─────────────
    def _write_phase(conn):
        # FTS5 sync: explicitly delete old entries before removing chunks
        old_chunks = conn.execute(
            "SELECT id, text FROM chunks WHERE file_path=?", (rel_path,)
        ).fetchall()
        for chunk_id, old_text in old_chunks:
            conn.execute(
                "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
                (chunk_id, old_text),
            )
        conn.execute("DELETE FROM chunks WHERE file_path=?", (rel_path,))

        for start_line, end_line, text, text_hash, embedding, is_new in gathered:
            cur = conn.execute(
                "INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?,?,?,?)",
                (rel_path, start_line, end_line, text),
            )
            chunk_id = cur.lastrowid
            # Sync to FTS5
            conn.execute(
                "INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)", (chunk_id, text)
            )
            # Vec insert only if embedding available
            if embedding is not None:
                try:
                    import sqlite_vec

                    conn.execute(
                        "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
                        (chunk_id, sqlite_vec.serialize_float32(embedding)),
                    )
                except Exception:
                    pass
            # Persist newly fetched embeddings into cache
            if is_new and embedding is not None:
                _save_embedding_cache(conn, text_hash, embedding)

        conn.execute(
            "INSERT OR REPLACE INTO files (path, content_hash, modified_at) VALUES (?,?,?)",
            (rel_path, h, path.stat().st_mtime),
        )
        conn.commit()

    writer.submit(_write_phase)


def hybrid_search(query, project="", max_results=None, min_score=None, timeout=None):
    """Run weighted fusion of FTS5 keyword + sqlite-vec cosine search."""
    cfg = get_config()
    if max_results is None:
        max_results = cfg.max_results
    if min_score is None:
        min_score = cfg.min_score

    deadline = None if timeout is None else time.monotonic() + timeout

    def _remaining_timeout():
        if deadline is None:
            return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("search timed out")
        return remaining

    writer = _get_search_writer()
    db = writer.get_reader()
    try:
        if deadline is not None:
            db.set_progress_handler(
                lambda: 1 if time.monotonic() >= deadline else 0,
                1000,
            )
        candidates = max_results * cfg.candidate_multiplier
        path_filter = f"{project}/%" if project else "%"

        if deadline is not None:
            _remaining_timeout()

        # Try to get query embedding (cache read via reader, cache write via writer)
        q_hash = hashlib.sha256(query.encode()).hexdigest()
        q_embedding = _get_embedding(
            db,
            query,
            q_hash,
            writer=writer,
            timeout=_remaining_timeout(),
        )

        vec_scores = {}
        if q_embedding is not None:
            try:
                import sqlite_vec

                vec_rows = db.execute(
                    """
                    SELECT c.id, c.file_path, c.start_line, c.end_line, c.text,
                           vec_distance_cosine(cv.embedding, ?) AS distance
                    FROM chunks_vec cv
                    JOIN chunks c ON c.id = cv.rowid
                    WHERE c.file_path LIKE ?
                    ORDER BY distance ASC
                    LIMIT ?
                    """,
                    (
                        sqlite_vec.serialize_float32(q_embedding),
                        path_filter,
                        candidates,
                    ),
                ).fetchall()
                vec_scores = {
                    row[0]: {
                        "path": row[1],
                        "start_line": row[2],
                        "end_line": row[3],
                        "text": row[4],
                        "vec_score": 1.0 - row[5],
                    }
                    for row in vec_rows
                }
            except sqlite3.OperationalError as exc:
                if "interrupted" in str(exc).lower():
                    raise TimeoutError("search timed out") from exc
                raise
            except Exception:
                pass

        # Keyword search (always available)
        try:
            fts_rows = db.execute(
                """
                SELECT c.id, c.file_path, c.start_line, c.end_line, c.text, rank
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.rowid
                WHERE chunks_fts MATCH ? AND c.file_path LIKE ?
                ORDER BY rank
                LIMIT ?
                """,
                (query, path_filter, candidates),
            ).fetchall()
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc).lower():
                raise TimeoutError("search timed out") from exc
            raise
        kw_scores = {
            row[0]: {
                "path": row[1],
                "start_line": row[2],
                "end_line": row[3],
                "text": row[4],
                "kw_score": 1.0 / (1.0 + abs(row[5])),
            }
            for row in fts_rows
        }
    finally:
        db.set_progress_handler(None, 0)
        db.close()

    # Weighted fusion
    all_ids = set(vec_scores) | set(kw_scores)
    results = []
    for chunk_id in all_ids:
        v = vec_scores.get(chunk_id, {})
        k = kw_scores.get(chunk_id, {})
        info = v or k
        score = cfg.vector_weight * v.get("vec_score", 0.0) + cfg.keyword_weight * k.get(
            "kw_score", 0.0
        )
        # Demote log.md hits when log_search_mode is "index"
        if cfg.log_search_mode == "index" and info["path"].endswith("/log.md"):
            score *= cfg.log_score_demotion
        if score < min_score:
            continue
        results.append(
            {
                "score": round(score, 4),
                "path": info["path"],
                "start_line": info["start_line"],
                "end_line": info["end_line"],
                "preview": info["text"][:700],
            }
        )

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:max_results]


def delete_indexed_prefix(prefix: str):
    """Delete all indexed data for files matching a path prefix."""
    writer = _get_search_writer()

    # Read phase: find matching files
    reader = writer.get_reader()
    try:
        rows = reader.execute(
            "SELECT path FROM files WHERE path LIKE ?", (prefix + "%",)
        ).fetchall()
    finally:
        reader.close()

    if not rows:
        return 0

    # Write phase: delete via writer
    def _delete_write(conn):
        for (file_path,) in rows:
            # FTS5 sync: delete old entries
            chunks = conn.execute(
                "SELECT id, text FROM chunks WHERE file_path=?", (file_path,)
            ).fetchall()
            for chunk_id, text in chunks:
                conn.execute(
                    "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
                    (chunk_id, text),
                )
            conn.execute("DELETE FROM chunks WHERE file_path=?", (file_path,))
            conn.execute("DELETE FROM files WHERE path=?", (file_path,))
        conn.commit()

    writer.submit(_delete_write)
    return len(rows)


def cleanup_orphaned_entries():
    """Find and remove search index entries for files that no longer exist on disk."""
    cfg = get_config()
    writer = _get_search_writer()

    # Read phase
    reader = writer.get_reader()
    try:
        rows = reader.execute("SELECT path FROM files").fetchall()
    finally:
        reader.close()

    # Identify orphans
    orphaned = []
    for (file_path,) in rows:
        full_path = cfg.byomem / file_path
        if not full_path.exists():
            orphaned.append(file_path)

    if not orphaned:
        return 0

    # Write phase
    def _cleanup_write(conn):
        for file_path in orphaned:
            chunks = conn.execute(
                "SELECT id, text FROM chunks WHERE file_path=?", (file_path,)
            ).fetchall()
            for chunk_id, text in chunks:
                conn.execute(
                    "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
                    (chunk_id, text),
                )
            conn.execute("DELETE FROM chunks WHERE file_path=?", (file_path,))
            conn.execute("DELETE FROM files WHERE path=?", (file_path,))
        conn.commit()

    writer.submit(_cleanup_write)
    return len(orphaned)


def _chunk_structured(content, rel_path, cfg):
    """Split content on semantic boundaries when file type is recognized.

    Dispatches based on file name:
      main.md    — split on ``- [`` entry lines
      commit.md  — split on ``## This Commit`` headers
      log.md     — split on ``<!-- last_id:`` anchors

    Falls back to generic line-based chunking for unrecognized files.
    Oversized single entries are sub-chunked via ``_chunk_text``.
    """
    import os

    basename = os.path.basename(rel_path)
    chunk_chars = cfg.chunk_tokens * cfg.approx_chars_per_token

    if basename == "main.md":
        return _split_on_delimiter(content, "- [", chunk_chars, cfg)
    elif basename == "commit.md":
        return _split_on_delimiter(content, "## This Commit", chunk_chars, cfg)
    elif basename == "log.md":
        return _split_on_delimiter(content, "<!-- last_id:", chunk_chars, cfg)
    else:
        return _chunk_text(content, cfg.chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token)


def _split_on_delimiter(content, delimiter, chunk_chars, cfg):
    """Split content into chunks at lines starting with *delimiter*.

    Lines before the first delimiter become a header chunk (if non-empty).
    Each subsequent section (delimiter line through the line before the next
    delimiter) becomes one chunk.  If a section exceeds *chunk_chars* it is
    sub-chunked via ``_chunk_text``.

    Returns list of ``(start_line, end_line, text)`` tuples (1-indexed lines).
    """
    lines = content.splitlines()
    sections = []  # list of (start_idx, end_idx) 0-indexed
    current_start = 0

    for i, line in enumerate(lines):
        if line.startswith(delimiter) and i > current_start:
            sections.append((current_start, i))
            current_start = i

    # Final section
    if current_start < len(lines):
        sections.append((current_start, len(lines)))

    chunks = []
    for start_idx, end_idx in sections:
        text = "\n".join(lines[start_idx:end_idx])
        if not text.strip():
            continue
        if len(text) > chunk_chars:
            # Oversized entry — sub-chunk it
            sub = _chunk_text(text, cfg.chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token)
            for s_start, s_end, s_text in sub:
                chunks.append((start_idx + s_start, start_idx + s_end, s_text))
        else:
            chunks.append((start_idx + 1, end_idx, text))

    return chunks


def _init_schema(db, embed_dim, vec_available=True):
    """Create tables if they don't exist."""
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, content_hash TEXT, modified_at REAL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY, file_path TEXT,
            start_line INTEGER, end_line INTEGER, text TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(text, content=chunks, content_rowid=id);
        CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT PRIMARY KEY, embedding BLOB
        );
    """
    )
    if vec_available:
        try:
            db.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec "
                f"USING vec0(embedding FLOAT[{embed_dim}])"
            )
        except Exception:
            pass
    db.commit()
