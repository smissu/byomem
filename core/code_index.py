"""Source code indexing: FTS5 + sqlite-vec hybrid search for codebase files."""

import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path

from core.config import get_config
from core.indexing_utils import (
    _chunk_text,
    _get_embedding,
    _get_embeddings_batch,
    _save_embedding_cache,
)


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
    dim = cfg.code_embedding_dimension or cfg.embedding_dimension
    _init_schema(db, dim, vec_available)
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
    # Migration: add description column if missing
    try:
        db.execute("ALTER TABLE chunks ADD COLUMN description TEXT")
    except Exception:
        pass  # column already exists
    db.commit()


def index_source_file(path: Path, project: str, db_path, source_root: Path | None = None):
    """Chunk, embed, and upsert a source file into the code index.

    Two-phase write pattern to minimise SQLite write-lock hold time:
      Phase 1 (GATHER): read file, check hash, chunk, fetch embeddings — no writes.
      Phase 2 (WRITE):  DELETE old + INSERT new in a single fast transaction.

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

    # --- Phase 1: GATHER (read-only, no write lock) ---

    cfg = get_config()
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

    chunks = _chunk_code(content, path.name)

    # Prepare texts and hashes for batch embedding fetch
    texts = []
    text_hashes = []
    for start_line, end_line, text in chunks:
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        texts.append(text)
        text_hashes.append(text_hash)

    # Batch fetch all embeddings (read-only: cache lookups + API calls, no DB writes)
    embed_results = _get_embeddings_batch(db, texts, text_hashes, model=cfg.code_embedding_model)

    # Release the read connection before the write phase
    db.close()

    # Collect gathered data: (start_line, end_line, text, text_hash, embedding, is_new)
    gathered = []
    for i, (start_line, end_line, text) in enumerate(chunks):
        embedding, is_new = embed_results[i]
        gathered.append((start_line, end_line, text, text_hashes[i], embedding, is_new))

    # --- Phase 2: WRITE (fast transaction, no API calls) ---

    db = get_code_db(db_path)

    # FTS5 sync: explicitly delete old entries before removing chunks
    old_chunks = db.execute("SELECT id, text FROM chunks WHERE file_path=?", (file_key,)).fetchall()
    for chunk_id, old_text in old_chunks:
        db.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
            (chunk_id, old_text),
        )
    db.execute("DELETE FROM chunks WHERE file_path=?", (file_key,))

    for start_line, end_line, text, text_hash, embedding, is_new in gathered:
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
        # Persist new embedding cache entries inside the write transaction
        if is_new and embedding is not None:
            _save_embedding_cache(db, text_hash, embedding)

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


def _extract_definition_name(first_line: str) -> str | None:
    """Extract the defined symbol name from the first line of a chunk.

    Supports Python (def/class), JS/TS (function/async function/export function),
    Go (func), and Rust (fn/pub fn/async fn/impl/struct/enum).
    Returns the lowercase name, or None if no definition found.
    """
    # Python: def foo(...) / class Foo:
    if first_line.startswith(("def ", "class ")):
        name = first_line.split("(", 1)[0].split(":", 1)[0]
        name = name.replace("def ", "").replace("class ", "").strip()
        return name.lower() if name else None

    # JS/TS: function foo / async function foo / export function foo / export async function foo
    # Also: export default function foo
    line = first_line
    for prefix in ("export default ", "export "):
        if line.startswith(prefix):
            line = line[len(prefix):]
    if line.startswith("async "):
        line = line[6:]
    if line.startswith("function "):
        name = line[9:].split("(", 1)[0].split("<", 1)[0].strip()
        return name.lower() if name else None

    # Go: func foo / func (r *Receiver) foo
    if first_line.startswith("func "):
        rest = first_line[5:]
        if rest.startswith("("):
            # Method: func (r *Type) Name(...)
            close = rest.find(")")
            if close >= 0:
                rest = rest[close + 1:].strip()
        name = rest.split("(", 1)[0].strip()
        return name.lower() if name else None

    # Rust: fn foo / pub fn foo / pub(crate) fn foo / async fn foo / pub async fn foo
    #       impl Foo / impl Trait for Foo / struct Foo / enum Foo
    rust_line = first_line
    for prefix in ("pub(crate) ", "pub(super) ", "pub "):
        if rust_line.startswith(prefix):
            rust_line = rust_line[len(prefix):]
    if rust_line.startswith("async "):
        rust_line = rust_line[6:]
    if rust_line.startswith("unsafe "):
        rust_line = rust_line[7:]
    if rust_line.startswith("fn "):
        name = rust_line[3:].split("(", 1)[0].split("<", 1)[0].strip()
        return name.lower() if name else None
    if rust_line.startswith(("impl ", "struct ", "enum ")):
        rest = rust_line.split(None, 1)[1] if " " in rust_line else ""
        # impl Trait for Type -> extract Type
        if " for " in rest:
            rest = rest.split(" for ", 1)[1]
        name = rest.split("<", 1)[0].split("(", 1)[0].split("{", 1)[0].split(";", 1)[0].strip()
        return name.lower() if name else None

    return None


def code_search(query, project="", max_results=None, min_score=None, db_path=None):
    """Run weighted fusion of FTS5 keyword + sqlite-vec cosine search over code index."""
    cfg = get_config()
    if db_path is None:
        db_path = cfg.code_db_path
    if max_results is None:
        max_results = cfg.max_results
    if min_score is None:
        min_score = cfg.code_min_score

    db = get_code_db(db_path)
    candidates = max_results * cfg.code_candidate_multiplier
    path_filter = f"{project}/%" if project else "%"

    # Try to get query embedding
    q_hash = hashlib.sha256(query.encode()).hexdigest()
    q_embedding = _get_embedding(db, query, q_hash, model=cfg.code_embedding_model)

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

    # Build query terms for definition boost matching
    query_terms = set(query.lower().split())

    # Weighted fusion (code-specific weights)
    all_ids = set(vec_scores) | set(kw_scores)
    results = []
    for chunk_id in all_ids:
        v = vec_scores.get(chunk_id, {})
        k = kw_scores.get(chunk_id, {})
        info = v or k
        score = cfg.code_vector_weight * v.get("vec_score", 0.0) + cfg.code_keyword_weight * k.get(
            "kw_score", 0.0
        )

        # Demote test files (Python: test_/tests/, JS/TS: __tests__/.test./.spec., Rust: /tests/)
        path = info["path"]
        if "/test_" in path or "/tests/" in path or "/__tests__/" in path or ".test." in path or ".spec." in path or "_test.rs" in path:
            score *= cfg.code_test_demotion

        # Boost chunks that define a queried term (function/class at chunk start)
        text = info["text"]
        first_line = text.split("\n", 1)[0].strip()
        defined_name = _extract_definition_name(first_line)
        if defined_name is not None:
            if defined_name in query_terms or any(t in defined_name for t in query_terms):
                score *= cfg.code_definition_boost

        if score < min_score:
            continue
        results.append(
            {
                "score": round(score, 4),
                "path": path,
                "start_line": info["start_line"],
                "end_line": info["end_line"],
                "preview": text[:700],
            }
        )

    results.sort(key=lambda r: (-r["score"], r["path"]))
    db.close()
    return results[:max_results]


def _is_function_boundary(stripped):
    """Check if a stripped line starts a function/class definition.

    Supports Python (def/class), JS/TS (function/async function/export function),
    Go (func), and Rust (fn/pub fn/async fn/impl/struct/enum).
    """
    # Python
    if stripped.startswith(("def ", "class ")):
        return True
    # JS/TS: strip export/async prefixes then check for function
    line = stripped
    for prefix in ("export default ", "export "):
        if line.startswith(prefix):
            line = line[len(prefix):]
    if line.startswith("async "):
        line = line[6:]
    if line.startswith("function "):
        return True
    # Go
    if stripped.startswith("func "):
        return True
    # Rust: strip visibility/async/unsafe prefixes then check for fn/impl/struct/enum
    rust = stripped
    for prefix in ("pub(crate) ", "pub(super) ", "pub "):
        if rust.startswith(prefix):
            rust = rust[len(prefix):]
    if rust.startswith("async "):
        rust = rust[6:]
    if rust.startswith("unsafe "):
        rust = rust[7:]
    if rust.startswith(("fn ", "impl ", "struct ", "enum ")):
        return True
    return False


def _chunk_code(content, filename):
    """Chunk source code content using function/class boundary splitting.

    Splits on def/class (Python), function/async function (JS/TS), func (Go),
    and fn/impl/struct/enum (Rust) boundaries. Falls back to generic line-based
    chunking for files without recognized boundaries.
    """
    cfg = get_config()
    chunk_tokens = cfg.code_chunk_tokens or cfg.chunk_tokens

    lines = content.splitlines()
    chunk_chars = chunk_tokens * cfg.approx_chars_per_token

    # Find all boundary lines with their indices and indentation levels
    boundaries = []
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if _is_function_boundary(stripped):
            indent = len(line) - len(stripped)
            is_container = stripped.startswith("class ") or stripped.startswith("impl ")
            boundaries.append((i, indent, is_container))

    if not boundaries:
        # No def/class found: fall back to generic chunker
        return _chunk_text(content, chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token)

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
                text, chunk_tokens, cfg.chunk_overlap, cfg.approx_chars_per_token
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
    """Return all git-tracked files under root as (Path, 'A') tuples.

    Uses ``git ls-files`` so untracked files and .gitignore'd paths are excluded.
    Falls back to rglob if git is unavailable (non-git repo).
    """
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        )
        return [(root / line, "A") for line in result.stdout.splitlines() if line]
    except (subprocess.CalledProcessError, FileNotFoundError):
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


def reconcile_project_index(project: str, tracked_paths: list[Path], db_path, source_root: Path):
    """Remove code.db entries for files no longer in the tracked set.

    Called after a full re-walk to clean up stale entries (e.g. files that
    were untracked or deleted since the initial index).

    Returns the number of stale entries removed.
    """
    tracked_keys = set()
    for p in tracked_paths:
        try:
            rel = p.relative_to(source_root)
        except ValueError:
            rel = p
        tracked_keys.add(f"{project}/{rel}")

    db = get_code_db(db_path)
    prefix = f"{project}/%"
    indexed = db.execute("SELECT path FROM files WHERE path LIKE ?", (prefix,)).fetchall()

    removed = 0
    for (file_key,) in indexed:
        if file_key not in tracked_keys:
            # FTS5 sync
            old_chunks = db.execute(
                "SELECT id, text FROM chunks WHERE file_path=?", (file_key,)
            ).fetchall()
            for chunk_id, old_text in old_chunks:
                db.execute(
                    "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
                    (chunk_id, old_text),
                )
            db.execute("DELETE FROM chunks WHERE file_path=?", (file_key,))
            db.execute("DELETE FROM files WHERE path=?", (file_key,))
            removed += 1

    if removed:
        db.commit()
    db.close()
    return removed


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
    """Store the last indexed git SHA and timestamp for project in code.db."""
    import time

    if db_path is None:
        db_path = get_config().code_db_path
    db = get_code_db(db_path)
    now = str(time.time())
    db.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (f"last_sha:{project}", sha),
    )
    db.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (f"last_indexed_at:{project}", now),
    )
    db.commit()
    db.close()
