"""Native-record search index: FTS5 lexical gate + embedding sidecar rerank."""

from __future__ import annotations

import hashlib
import math
import sqlite3
from pathlib import Path
import re
import struct

from core.config import get_config
from core.indexing_utils import _get_embedding, _get_embeddings_batch, _save_embedding_cache
from core.models import MemoryRecord

_STOPWORDS = {"a", "an", "and", "for", "in", "of", "on", "or", "the", "to"}
_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def _native_index_path() -> Path:
    return get_config().byomem / "native" / "native_search.db"


def native_index_path_for_store(root: Path) -> Path:
    return root / "native_search.db"


def _vec_available() -> bool:
    try:
        import sqlite_vec  # noqa: F401

        return True
    except Exception:
        return False


def get_native_index_db(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or _native_index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS native_records (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            lifecycle TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            content_len INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS native_records_fts
            USING fts5(content, content='native_records', content_rowid='rowid');
        CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT PRIMARY KEY,
            embedding BLOB
        );
        CREATE TABLE IF NOT EXISTS native_record_embeddings (
            record_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            embedding BLOB NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    if _vec_available():
        try:
            dim = get_config().embedding_dimension
            db.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS native_record_vec USING vec0(embedding FLOAT[{dim}])")
        except Exception:
            pass
    db.commit()
    return db


def _serialize_embedding(embedding: list[float]) -> bytes:
    return struct.pack(f"{len(embedding)}f", *embedding)


def _deserialize_embedding(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    return list(struct.unpack(f"{len(blob) // 4}f", blob))


def _tokenize_query(query: str) -> list[str]:
    raw_tokens = [token.lower() for token in _TOKEN_RE.findall(query)]
    return [token for token in raw_tokens if token not in _STOPWORDS]


def _normalize_query(query: str) -> str:
    tokens = _tokenize_query(query)
    return " OR ".join(dict.fromkeys(tokens))


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    a_norm = math.sqrt(sum(x * x for x in a))
    b_norm = math.sqrt(sum(y * y for y in b))
    if a_norm == 0.0 or b_norm == 0.0:
        return 0.0
    return dot / (a_norm * b_norm)


def _embed_record_text(record: MemoryRecord) -> str:
    return record.content.strip()


def _upsert_embedding_sidecar(db: sqlite3.Connection, record: MemoryRecord, text_hash: str, embedding: list[float] | None) -> None:
    db.execute("DELETE FROM native_record_embeddings WHERE record_id=?", (record.id,))
    if embedding is None:
        return
    blob = _serialize_embedding(embedding)
    db.execute("INSERT INTO native_record_embeddings (record_id, scope, scope_id, text_hash, embedding, updated_at) VALUES (?,?,?,?,?,?)", (record.id, record.scope, record.scope_id, text_hash, blob, record.updated_at))
    try:
        import sqlite_vec

        db.execute("DELETE FROM native_record_vec WHERE rowid=?", (record.id,))
        db.execute("INSERT INTO native_record_vec (rowid, embedding) VALUES (?, ?)", (record.id, sqlite_vec.serialize_float32(embedding)))
    except Exception:
        pass


def index_native_record(record: MemoryRecord, db_path: Path | None = None) -> None:
    db = get_native_index_db(db_path)
    try:
        content_hash = hashlib.sha256(record.content.encode("utf-8")).hexdigest()
        content_len = len(record.content)
        row = db.execute("SELECT rowid, content_hash FROM native_records WHERE id=?", (record.id,)).fetchone()
        if row and row[1] == content_hash:
            return
        if row:
            db.execute("DELETE FROM native_records_fts WHERE rowid=?", (row[0],))
            db.execute("DELETE FROM native_records WHERE id=?", (record.id,))
        cur = db.execute("INSERT INTO native_records (id, scope, scope_id, created_at, updated_at, source, content, lifecycle, content_hash, content_len) VALUES (?,?,?,?,?,?,?,?,?,?)", (record.id, record.scope, record.scope_id, record.created_at, record.updated_at, record.source, record.content, record.lifecycle, content_hash, content_len))
        db.execute("INSERT INTO native_records_fts(rowid, content) VALUES (?, ?)", (cur.lastrowid, record.content))

        embed_text = _embed_record_text(record)
        text_hash = hashlib.sha256(embed_text.encode("utf-8")).hexdigest()
        embedding_results = _get_embeddings_batch(db, [embed_text], [text_hash], batch_size=1)
        embedding, is_new = embedding_results[0] if embedding_results else (None, False)
        if is_new and embedding is not None:
            _save_embedding_cache(db, text_hash, embedding)
        _upsert_embedding_sidecar(db, record, text_hash, embedding)
        db.commit()
    finally:
        db.close()


def _fts_candidates(db: sqlite3.Connection, scope: str, scope_id: str, query: str, allowed: list[str]) -> list[tuple]:
    normalized_query = _normalize_query(query)
    if not normalized_query:
        return []
    lifecycle_sql = ",".join("?" for _ in allowed)
    try:
        return db.execute(
            f"""
            SELECT n.id, n.scope, n.scope_id, n.created_at, n.updated_at, n.source, n.content, n.lifecycle,
                   bm25(native_records_fts) AS lexical_rank
            FROM native_records_fts
            JOIN native_records n ON n.rowid = native_records_fts.rowid
            WHERE native_records_fts MATCH ? AND n.scope = ? AND n.scope_id = ? AND n.lifecycle IN ({lifecycle_sql})
            ORDER BY lexical_rank, n.updated_at DESC, n.id ASC
            """,
            (normalized_query, scope, scope_id, *allowed),
        ).fetchall()
    except sqlite3.OperationalError:
        return []


def search_native_records(scope: str, scope_id: str, query: str, lifecycle: list[str] | None = None, db_path: Path | None = None) -> list[dict[str, object]]:
    _ = query
    db = get_native_index_db(db_path)
    try:
        allowed = lifecycle or ["active", "archived", "superseded"]
        rows = _fts_candidates(db, scope, scope_id, query, allowed)
        from core.memory_store import get_native_store

        stored_records = {record.id: record for record in get_native_store().retrieve(scope=scope, scope_id=scope_id)}
        lexical_records: list[dict[str, object]] = []
        for idx, row in enumerate(rows):
            record = stored_records.get(row[0]) or MemoryRecord(id=row[0], scope=row[1], scope_id=row[2], created_at=row[3], updated_at=row[4], source=row[5], content=row[6], lifecycle=row[7], source_kind="pi_native_store")
            lexical_score = 1.0 / (1.0 + idx)
            lexical_records.append({"record": record, "candidate_source": "fts", "lexical_rank": row[8], "lexical_score": lexical_score, "semantic_available": False, "semantic_rerank_applied": False, "semantic_score": None})

        query_embedding = _get_embedding(db, query, hashlib.sha256(query.encode("utf-8")).hexdigest())
        if query_embedding is None:
            return lexical_records[:10]
        semantic_records: list[dict[str, object]] = []
        if query_embedding is not None:
            semantic_rows = db.execute("SELECT e.record_id, n.scope, n.scope_id, n.created_at, n.updated_at, n.source, n.content, n.lifecycle, e.embedding FROM native_record_embeddings e JOIN native_records n ON n.id = e.record_id WHERE e.scope=? AND e.scope_id=? AND n.lifecycle IN (%s) ORDER BY n.updated_at DESC, n.id ASC" % ",".join("?" for _ in allowed), (scope, scope_id, *allowed)).fetchall()
            for row in semantic_rows:
                embedding = _deserialize_embedding(row[8])
                if embedding is None:
                    continue
                semantic_score = _cosine_similarity(query_embedding, embedding)
                if semantic_score < 0.25:
                    continue
                semantic_records.append({"record": MemoryRecord(id=row[0], scope=row[1], scope_id=row[2], created_at=row[3], updated_at=row[4], source=row[5], content=row[6], lifecycle=row[7], source_kind="pi_native_store"), "candidate_source": "semantic", "lexical_rank": None, "lexical_score": 0.0, "semantic_available": True, "semantic_rerank_applied": False, "semantic_score": semantic_score})
            semantic_records.sort(key=lambda item: item["semantic_score"], reverse=True)

        if lexical_records:
            if semantic_records:
                semantic_by_id = {c["record"].id: c for c in semantic_records}
                merged: list[dict[str, object]] = []
                for candidate in lexical_records:
                    record = candidate["record"]
                    if record.id in semantic_by_id:
                        semantic_candidate = semantic_by_id[record.id]
                        merged.append({**semantic_candidate, **candidate, "candidate_source": "hybrid", "semantic_available": True, "semantic_rerank_applied": True, "semantic_score": semantic_candidate.get("semantic_score")})
                    else:
                        merged.append(candidate)
                return merged[:10]
            return lexical_records[:10]
        return semantic_records[:10]
    finally:
        db.close()
