"""Hybrid search index: SQLite FTS5 (BM25) + sqlite-vec (cosine)."""
import hashlib
import sqlite3
from pathlib import Path

import openai

from core.config import get_config

CANDIDATE_MULT = 4


def get_db(db_path=None):
    """Connect to search DB, load sqlite-vec, and initialise schema."""
    cfg = get_config()
    path = db_path or cfg.db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
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
    """Chunk, embed, and upsert a file into the search index."""
    cfg = get_config()
    db = get_db()
    rel_path = str(path.relative_to(cfg.byomem))
    content = path.read_text()
    h = hashlib.sha256(content.encode()).hexdigest()

    row = db.execute(
        "SELECT content_hash FROM files WHERE path=?", (rel_path,)
    ).fetchone()
    if row and row[0] == h:
        return  # unchanged

    # FTS5 sync: explicitly delete old entries before removing chunks
    old_chunks = db.execute(
        "SELECT id, text FROM chunks WHERE file_path=?", (rel_path,)
    ).fetchall()
    for chunk_id, old_text in old_chunks:
        db.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (chunk_id, old_text),
        )
    db.execute("DELETE FROM chunks WHERE file_path=?", (rel_path,))

    chunks = _chunk_text(content, cfg.chunk_tokens, cfg.chunk_overlap)

    for start_line, end_line, text in chunks:
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        embedding = _get_embedding(db, text, text_hash)

        cur = db.execute(
            "INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?,?,?,?)",
            (rel_path, start_line, end_line, text),
        )
        chunk_id = cur.lastrowid
        # Sync to FTS5
        db.execute(
            "INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)", (chunk_id, text)
        )
        # Vec insert only if embedding available
        if embedding is not None:
            try:
                import sqlite_vec

                db.execute(
                    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
                    (chunk_id, sqlite_vec.serialize_float32(embedding)),
                )
            except Exception:
                pass

    db.execute(
        "INSERT OR REPLACE INTO files (path, content_hash, modified_at) VALUES (?,?,?)",
        (rel_path, h, path.stat().st_mtime),
    )
    db.commit()


def hybrid_search(query, project="", max_results=None, min_score=None):
    """Run weighted fusion of FTS5 keyword + sqlite-vec cosine search."""
    cfg = get_config()
    if max_results is None:
        max_results = cfg.max_results
    if min_score is None:
        min_score = cfg.min_score
    db = get_db()
    candidates = max_results * CANDIDATE_MULT
    path_filter = f"{project}/%" if project else "%"

    # Try to get query embedding
    q_hash = hashlib.sha256(query.encode()).hexdigest()
    q_embedding = _get_embedding(db, query, q_hash)

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
        except Exception:
            pass

    # Keyword search (always available)
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


def _get_embedding(db, text, text_hash):
    """Return cached embedding or generate via OpenAI. Returns None on failure."""
    row = db.execute(
        "SELECT embedding FROM embedding_cache WHERE text_hash=?", (text_hash,)
    ).fetchone()
    if row:
        import sqlite_vec

        return sqlite_vec.deserialize_float32(row[0])
    try:
        cfg = get_config()
        resp = openai.OpenAI().embeddings.create(model=cfg.embedding_model, input=text)
        embedding = resp.data[0].embedding
        import sqlite_vec

        db.execute(
            "INSERT INTO embedding_cache (text_hash, embedding) VALUES (?,?)",
            (text_hash, sqlite_vec.serialize_float32(embedding)),
        )
        return embedding
    except Exception:
        return None


def _chunk_text(text, chunk_tokens, chunk_overlap):
    """Line-based chunking with overlap. ~4 chars per token approximation."""
    lines = text.splitlines()
    chunks = []
    i = 0
    approx_chars_per_token = 4
    chunk_chars = chunk_tokens * approx_chars_per_token
    overlap_chars = chunk_overlap * approx_chars_per_token

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
