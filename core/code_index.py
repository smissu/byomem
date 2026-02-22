"""Source code indexing: FTS5 + sqlite-vec hybrid search for codebase files."""

import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path

from core.config import get_config
from core.indexing_utils import _chunk_text, _get_embedding


def get_code_db(db_path):
    """Connect to code DB at db_path, load sqlite-vec, and initialise schema."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(db_path), timeout=10)
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
    cfg = get_config()
    _init_schema(db, cfg.embedding_dimension, vec_available)
    return db


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
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY, value TEXT
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


def index_source_file(path: Path, project: str, db_path, source_root: Path | None = None):
    """Chunk, embed, and upsert a source file into the code index.

    Args:
        path: Absolute path to the source file.
        project: Project name used as key prefix.
        db_path: Path to the code.db file.
        source_root: If given, store path relative to source_root (cleaner keys).
    """
    if path.is_symlink():
        return
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        print(f"[code_index] UnicodeDecodeError reading {path}: {e}", file=sys.stderr)
        return
    except PermissionError as e:
        print(f"[code_index] PermissionError reading {path}: {e}", file=sys.stderr)
        return

    db = get_code_db(db_path)
    if source_root is not None:
        try:
            rel = path.relative_to(source_root)
        except ValueError:
            rel = path
    else:
        rel = path
    file_key = f"{project}/{rel}"
    h = hashlib.sha256(content.encode("utf-8")).hexdigest()

    row = db.execute("SELECT content_hash FROM files WHERE path=?", (file_key,)).fetchone()
    if row and row[0] == h:
        db.close()
        return  # unchanged

    # FTS5 sync: explicitly delete old entries before removing chunks
    old_chunks = db.execute("SELECT id, text FROM chunks WHERE file_path=?", (file_key,)).fetchall()
    for chunk_id, old_text in old_chunks:
        db.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (chunk_id, old_text),
        )
    db.execute("DELETE FROM chunks WHERE file_path=?", (file_key,))

    chunks = _chunk_code(content, path.name)

    for start_line, end_line, text in chunks:
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        embedding = _get_embedding(db, text, text_hash)

        cur = db.execute(
            "INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?,?,?,?)",
            (file_key, start_line, end_line, text),
        )
        chunk_id = cur.lastrowid
        # Sync to FTS5
        db.execute("INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)", (chunk_id, text))
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
        (file_key, h, path.stat().st_mtime),
    )
    db.commit()
    db.close()


def delete_indexed_source_file(
    path_str: str, project: str, db_path, source_root: Path | None = None
):
    """Remove all chunks and index entries for a source file path.

    Args:
        path_str: Absolute (or relative) path string for the file.
        source_root: If given, make path_str relative to source_root before keying.
    """
    if source_root is not None:
        try:
            rel = Path(path_str).relative_to(source_root)
            path_str = str(rel)
        except ValueError:
            pass
    file_key = f"{project}/{path_str}"
    db = get_code_db(db_path)

    old_chunks = db.execute("SELECT id, text FROM chunks WHERE file_path=?", (file_key,)).fetchall()
    for chunk_id, old_text in old_chunks:
        db.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (chunk_id, old_text),
        )
    db.execute("DELETE FROM chunks WHERE file_path=?", (file_key,))
    db.execute("DELETE FROM files WHERE path=?", (file_key,))
    db.commit()
    db.close()


def code_search(query, project="", max_results=None, min_score=None, db_path=None):
    """Run weighted fusion of FTS5 keyword + sqlite-vec cosine search over code index."""
    cfg = get_config()
    if db_path is None:
        db_path = cfg.code_db_path
    if max_results is None:
        max_results = cfg.max_results
    if min_score is None:
        min_score = cfg.min_score

    db = get_code_db(db_path)
    candidates = max_results * cfg.candidate_multiplier
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

    results.sort(key=lambda r: (-r["score"], r["path"]))
    db.close()
    return results[:max_results]


def _chunk_code(content, filename):
    """Chunk source code content. Python files use def/class boundaries; others use generic chunker."""
    cfg = get_config()

    if not filename.endswith(".py"):
        return _chunk_text(content, cfg.chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token)

    # Python-aware chunking: split on def/class boundaries
    lines = content.splitlines()
    chunk_chars = cfg.chunk_tokens * cfg.approx_chars_per_token

    # Find all boundary lines with their indices and indentation levels
    boundaries = []
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("def ") or stripped.startswith("class "):
            indent = len(line) - len(stripped)
            boundaries.append((i, indent, stripped.startswith("class ")))

    if not boundaries:
        # No def/class found: fall back to generic chunker
        return _chunk_text(content, cfg.chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token)

    chunks = []
    for idx, (line_idx, indent, is_class) in enumerate(boundaries):
        # Chunk spans from this boundary to the next boundary (or EOF)
        if idx + 1 < len(boundaries):
            end_idx = boundaries[idx + 1][0]
        else:
            end_idx = len(lines)

        chunk_lines = lines[line_idx:end_idx]

        # For method chunks (indented def, indent > 0): prepend enclosing class header
        if not is_class and indent > 0:
            # Find the most recent class boundary with smaller indentation
            enclosing_class_line = None
            for prev_line_idx, prev_indent, prev_is_class in reversed(boundaries[:idx]):
                if prev_is_class and prev_indent < indent:
                    enclosing_class_line = lines[prev_line_idx]
                    break
            if enclosing_class_line is not None:
                chunk_lines = [enclosing_class_line] + chunk_lines

        text = "\n".join(chunk_lines)

        if not text.strip():
            continue

        # Sub-chunk oversized chunks
        if len(text) > chunk_chars:
            sub_chunks = _chunk_text(
                text, cfg.chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token
            )
            for s_start, s_end, s_text in sub_chunks:
                # Offset line numbers back to original file positions
                chunks.append((line_idx + s_start, line_idx + s_end, s_text))
        else:
            # 1-indexed line numbers
            chunks.append((line_idx + 1, end_idx, text))

    return chunks


def get_changed_source_files(root: Path, last_sha):
    """Return list of (Path, status) tuples for files changed since last_sha.

    If last_sha is None, returns all files in root (full reindex).
    Falls back to full reindex on git errors.
    """
    if last_sha is None:
        return _walk_all_files(root)
    try:
        result = subprocess.run(
            ["git", "diff", "--name-status", last_sha, "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        )
        return _parse_git_diff(result.stdout, root)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"[code_index] git diff failed ({e}), falling back to full walk", file=sys.stderr)
        return _walk_all_files(root)


def _walk_all_files(root: Path):
    """Return all non-symlink files under root as (Path, 'A') tuples."""
    return [(p, "A") for p in root.rglob("*") if p.is_file() and not p.is_symlink()]


def _parse_git_diff(stdout: str, root: Path):
    """Parse git diff --name-status output into (Path, status) tuples.

    Handles renames (R lines) by emitting a delete for old path and add for new.
    Filters out any paths that resolve outside root (security).
    """
    results = []
    root_resolved = root.resolve()

    for line in stdout.splitlines():
        line = line.rstrip()
        if not line:
            continue

        parts = line.split("\t")
        status = parts[0]

        if status.startswith("R"):
            # Rename: parts[1] = old path, parts[2] = new path
            if len(parts) >= 3:
                pairs = [("D", parts[1]), ("A", parts[2])]
            else:
                continue
        else:
            if len(parts) < 2:
                continue
            pairs = [(status, parts[1])]

        for st, rel_path_str in pairs:
            # Handle absolute paths
            if rel_path_str.startswith("/"):
                candidate = Path(rel_path_str)
            else:
                candidate = root / rel_path_str

            # Security filter: must be within root
            try:
                candidate.resolve().relative_to(root_resolved)
            except ValueError:
                continue  # outside root — skip

            # Return non-resolved path (what tests expect)
            if rel_path_str.startswith("/"):
                results.append((candidate, st))
            else:
                results.append((root / rel_path_str, st))

    return results


def clear_project_index(project: str, db_path):
    """Delete all index entries for project from code DB (chunks + files tables)."""
    db = get_code_db(db_path)
    prefix = f"{project}/%"

    # FTS5 sync: delete from chunks_fts before removing chunks rows
    old_chunks = db.execute(
        "SELECT id, text FROM chunks WHERE file_path LIKE ?", (prefix,)
    ).fetchall()
    for chunk_id, old_text in old_chunks:
        db.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (chunk_id, old_text),
        )

    db.execute("DELETE FROM chunks WHERE file_path LIKE ?", (prefix,))
    db.execute("DELETE FROM files WHERE path LIKE ?", (prefix,))
    db.commit()
    db.close()


def get_last_indexed_sha(project: str, db_path=None):
    """Return the last indexed git SHA for project, or None if never indexed."""
    if db_path is None:
        db_path = get_config().code_db_path
    db = get_code_db(db_path)
    row = db.execute("SELECT value FROM meta WHERE key=?", (f"last_sha:{project}",)).fetchone()
    db.close()
    return row[0] if row else None


def set_last_indexed_sha(project: str, sha: str, db_path=None):
    """Store the last indexed git SHA for project in code.db."""
    if db_path is None:
        db_path = get_config().code_db_path
    db = get_code_db(db_path)
    db.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (f"last_sha:{project}", sha),
    )
    db.commit()
    db.close()
