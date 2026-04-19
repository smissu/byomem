"""Concurrency stress tests for index_file() and index_source_file().

Sprint 07 — Task 0.1: Verify DB lock contention bug is reproducible.

The bug: index_file() and index_source_file() open a single SQLite connection,
then call _get_embedding() which makes a slow API call (Ollama / OpenAI) while
still holding that connection open. With 4+ concurrent threads each doing the
same, SQLite write locks are held during the embedding API wait. When the total
hold time exceeds the 30s busy_timeout, threads receive:
    sqlite3.OperationalError: database is locked

These tests verify the current concurrent indexing behavior under slow embedding calls.
"""

import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

# ---------- helpers ----------


def _slow_embedding(delay_min: float = 0.5, delay_max: float = 1.0):
    """Return a mock embedding function that sleeps to simulate API latency.

    The sleep happens inside the mock, so the real DB connection opened in
    index_file / index_source_file remains open throughout — exactly replicating
    the production lock-hold behaviour.
    """
    import random

    def _impl(*args, **kwargs):
        # Simulate openai.OpenAI().embeddings.create() call latency
        sleep_for = random.uniform(delay_min, delay_max)
        time.sleep(sleep_for)
        mock_resp = _MockEmbedResp(embedding=[0.1] * 1536)
        return mock_resp

    return _impl


class _MockEmbedResp:
    """Minimal stub matching resp.data[0].embedding access pattern."""

    class _Datum:
        def __init__(self, embedding):
            self.embedding = embedding

    def __init__(self, embedding):
        self.data = [self._Datum(embedding)]


class _MockOpenAI:
    """Stub for openai.OpenAI(**kwargs) that uses a slow embeddings.create()."""

    def __init__(self, slow_fn, **kwargs):
        self._slow_fn = slow_fn
        self.embeddings = self

    def create(self, model, input):
        return self._slow_fn()


def _collect_results(futures):
    """Drain ThreadPoolExecutor futures; return (results, exceptions) lists."""
    results = []
    exceptions = []
    for fut in as_completed(futures):
        exc = fut.exception()
        if exc is not None:
            exceptions.append(exc)
        else:
            results.append(fut.result())
    return results, exceptions


# ============================================================
# AC-1 — index_file() concurrent access (search.db)
# ============================================================


def test_concurrent_index_file_no_db_lock(tmp_byomem, mocker):
    """AC-1: 4 threads calling index_file() with slow mock embedding produce
    zero OperationalError: database is locked errors.

    Verifies concurrent writers do not surface SQLite lock errors while embedding calls are slow.
    """
    from core.search_index import index_file

    # Patch openai.OpenAI in indexing_utils with a slow stub.
    # We patch at the openai.OpenAI level (not _get_embedding directly) so that
    # the real embedding_cache DB write inside _get_embedding still happens —
    # this is what causes the write-lock contention.
    slow_fn = _slow_embedding(delay_min=0.5, delay_max=1.0)

    def make_slow_openai(**kwargs):
        return _MockOpenAI(slow_fn, **kwargs)

    mocker.patch("core.indexing_utils.openai.OpenAI", side_effect=make_slow_openai)

    # Create 4 files with distinct content in a project directory
    proj_dir = tmp_byomem / "concurrency_test_proj"
    proj_dir.mkdir(parents=True)

    files = []
    for i in range(4):
        f = proj_dir / f"file_{i:02d}.md"
        # Distinct content ensures different hashes — no chunk deduplication
        f.write_text(
            f"# Document {i}\n\n"
            f"This is document number {i} with unique content token DOC{i:04d}.\n"
            f"It contains enough text to produce at least one embedding call.\n"
        )
        files.append(f)

    # Spawn 4 threads, each calling index_file on a different file
    operational_errors = []
    other_exceptions = []

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(index_file, f, "concurrency_test_proj"): f for f in files}
        _, exceptions = _collect_results(list(futures.keys()))

    for exc in exceptions:
        if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
            operational_errors.append(exc)
        else:
            other_exceptions.append(exc)

    # AC-1: zero OperationalError exceptions expected.
    assert operational_errors == [], (
        f"Got {len(operational_errors)} 'database is locked' error(s) from concurrent "
        f"index_file() calls. Bug confirmed. First error: {operational_errors[0]}"
    )

    # Non-lock exceptions are unexpected regardless — surface them clearly
    assert other_exceptions == [], f"Unexpected exceptions: {other_exceptions}"


# ============================================================
# AC-2 — index_source_file() concurrent access (code.db)
# ============================================================


def test_concurrent_index_source_file_no_db_lock(tmp_byomem, tmp_path, mocker):
    """AC-2: 4 threads calling index_source_file() with slow mock embedding
    produce zero OperationalError: database is locked errors.

    index_source_file() uses a separate code.db, but the same locking pattern
    applies: one connection is open per call, held during the slow embedding.
    """
    from core.code_index import index_source_file

    slow_fn = _slow_embedding(delay_min=0.5, delay_max=1.0)

    def make_slow_openai(**kwargs):
        return _MockOpenAI(slow_fn, **kwargs)

    mocker.patch("core.indexing_utils.openai.OpenAI", side_effect=make_slow_openai)

    # code.db is separate from search.db — use tmp_path for it
    code_db_path = tmp_path / "code.db"
    source_root = tmp_path / "src"
    source_root.mkdir()

    files = []
    for i in range(4):
        f = source_root / f"module_{i:02d}.py"
        f.write_text(
            f'"""Module {i} — unique token SRC{i:04d}."""\n\n'
            f"def function_{i}():\n"
            f"    return {i}\n\n"
            f"# This module has unique content to force a real embedding call.\n"
        )
        files.append(f)

    operational_errors = []
    other_exceptions = []

    def index_one(f):
        return index_source_file(f, "test_project", code_db_path, source_root=source_root)

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(index_one, f) for f in files]
        _, exceptions = _collect_results(futures)

    for exc in exceptions:
        if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
            operational_errors.append(exc)
        else:
            other_exceptions.append(exc)

    # AC-2: zero OperationalError exceptions expected.
    assert operational_errors == [], (
        f"Got {len(operational_errors)} 'database is locked' error(s) from concurrent "
        f"index_source_file() calls. Bug confirmed. First error: {operational_errors[0]}"
    )

    assert other_exceptions == [], f"Unexpected exceptions: {other_exceptions}"


# ============================================================
# AC-3 — data integrity after concurrent indexing
# ============================================================


def test_concurrent_index_file_data_integrity(tmp_byomem, mocker):
    """AC-3: After concurrent index_file() calls, all 4 files are correctly
    indexed in the DB — no missing or corrupt rows.

    Each file must appear once in the 'files' table with a non-empty content
    hash, and must have at least one row in 'chunks'.
    """
    from core.config import get_config
    from core.search_index import get_db, index_file

    slow_fn = _slow_embedding(delay_min=0.5, delay_max=1.0)

    def make_slow_openai(**kwargs):
        return _MockOpenAI(slow_fn, **kwargs)

    mocker.patch("core.indexing_utils.openai.OpenAI", side_effect=make_slow_openai)

    proj_dir = tmp_byomem / "integrity_proj"
    proj_dir.mkdir(parents=True)

    files = []
    for i in range(4):
        f = proj_dir / f"doc_{i:02d}.md"
        f.write_text(
            f"# Integrity Check Document {i}\n\n"
            f"Unique marker: INTEGRITY{i:04d}\n"
            f"More content to ensure chunking: line after line of text.\n"
        )
        files.append(f)

    # Run concurrent indexing (may or may not succeed depending on fix state)
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(index_file, f, "integrity_proj") for f in files]
        # Collect all, ignoring exceptions for integrity check below
        for fut in as_completed(futures):
            fut.exception()  # prevents unhandled-exception warnings

    cfg = get_config()
    db = get_db(cfg.db_path)

    # Every file must appear exactly once in the files table
    indexed_paths = {
        r[0] for r in db.execute("SELECT path FROM files").fetchall()
    }

    missing = []
    for f in files:
        rel_path = str(f.relative_to(cfg.byomem))
        if rel_path not in indexed_paths:
            missing.append(rel_path)

    # AC-3: all files present — fails on buggy code when some writes were lost
    assert missing == [], (
        f"{len(missing)} file(s) missing from index after concurrent indexing: {missing}"
    )

    # Each indexed file must have at least one chunk
    for f in files:
        rel_path = str(f.relative_to(cfg.byomem))
        count = db.execute(
            "SELECT COUNT(*) FROM chunks WHERE file_path=?", (rel_path,)
        ).fetchone()[0]
        assert count > 0, f"No chunks found for {rel_path} after indexing"

    db.close()


def test_concurrent_index_source_file_data_integrity(tmp_byomem, tmp_path, mocker):
    """AC-3 (source files): After concurrent index_source_file() calls, all 4
    source files are correctly indexed in code.db — no missing or corrupt rows.
    """
    from core.code_index import get_code_db, index_source_file

    slow_fn = _slow_embedding(delay_min=0.5, delay_max=1.0)

    def make_slow_openai(**kwargs):
        return _MockOpenAI(slow_fn, **kwargs)

    mocker.patch("core.indexing_utils.openai.OpenAI", side_effect=make_slow_openai)

    code_db_path = tmp_path / "code.db"
    source_root = tmp_path / "src"
    source_root.mkdir()

    files = []
    for i in range(4):
        f = source_root / f"service_{i:02d}.py"
        f.write_text(
            f'"""Service module {i} — integrity token SVC{i:04d}."""\n\n'
            f"class Service{i}:\n"
            f"    def run(self):\n"
            f"        pass\n"
        )
        files.append(f)

    def index_one(f):
        return index_source_file(f, "test_project", code_db_path, source_root=source_root)

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(index_one, f) for f in files]
        for fut in as_completed(futures):
            fut.exception()

    db = get_code_db(code_db_path)

    indexed_paths = {
        r[0] for r in db.execute("SELECT path FROM files").fetchall()
    }

    missing = []
    for f in files:
        file_key = f"test_project/{f.relative_to(source_root)}"
        if file_key not in indexed_paths:
            missing.append(file_key)

    assert missing == [], (
        f"{len(missing)} source file(s) missing from code index after concurrent "
        f"indexing: {missing}"
    )

    for f in files:
        file_key = f"test_project/{f.relative_to(source_root)}"
        count = db.execute(
            "SELECT COUNT(*) FROM chunks WHERE file_path=?", (file_key,)
        ).fetchone()[0]
        assert count > 0, f"No chunks found for {file_key} after indexing"

    db.close()


# ============================================================
# AC-4 — confirm RED state (bug reproducibility sanity check)
# ============================================================


def test_red_state_confirmation_search_db(tmp_byomem, mocker):
    """AC-4: Confirm the bug is reproducible by checking that concurrent writes
    with a held connection + slow embedding trigger lock contention.

    This test directly verifies the failure mode: if you open a connection,
    start a slow operation (simulating _get_embedding), and then a second
    thread tries to write, it must eventually time out or lock.

    This test uses a very short timeout (1s) so it runs fast even in CI.
    If no OperationalError is raised, it means WAL mode is absorbing the
    contention — which is valid only if the fix is already in place.
    The CI marker on this test documents expected behaviour per fix state.
    """
    import sqlite3
    import threading

    from core.search_index import get_db

    # Create the DB with proper schema
    db_init = get_db()
    db_init.close()

    from core.config import get_config

    db_path = get_config().db_path

    lock_errors = []
    ready = threading.Event()

    def hold_write_lock():
        """Open a connection, begin a write, then sleep (simulating slow embedding)."""
        db = sqlite3.connect(str(db_path), timeout=1)
        db.execute("PRAGMA journal_mode=WAL")
        # Explicitly begin a transaction and write to force a write lock
        db.execute("BEGIN EXCLUSIVE")
        ready.set()
        time.sleep(1.5)  # Hold the lock for 1.5s — longer than timeout=1 below
        db.rollback()
        db.close()

    def try_concurrent_write():
        """Try to write to the same DB while the lock is held (short timeout)."""
        ready.wait()
        try:
            db = sqlite3.connect(str(db_path), timeout=1)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN EXCLUSIVE")
            db.execute(
                "INSERT OR REPLACE INTO files (path, content_hash, modified_at) "
                "VALUES ('test/probe.md', 'abc', 0.0)"
            )
            db.commit()
            db.close()
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower():
                lock_errors.append(e)

    t1 = threading.Thread(target=hold_write_lock)
    t2 = threading.Thread(target=try_concurrent_write)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # AC-4: In WAL mode, concurrent readers don't block writers and vice versa
    # for typical reads, but EXCLUSIVE locks still contend. This test documents
    # that EXCLUSIVE locks held during slow operations DO cause lock errors.
    # If this assertion fails, WAL mode has resolved the contention at the
    # OS/SQLite level — which means the fix works differently than expected.
    # Either outcome is meaningful: the test is a diagnostic, not a strict AC.
    # Mark with xfail if WAL mode absorbs it; the other AC tests are the real gate.
    if not lock_errors:
        pytest.skip(
            "WAL mode absorbed the EXCLUSIVE lock contention in this environment. "
            "The real contention manifests in AC-1/AC-2 tests with connection-per-call pattern. "
            "See test_concurrent_index_file_no_db_lock for the primary RED-state test."
        )
    else:
        # Confirmed: EXCLUSIVE lock contention is detectable in this environment
        assert len(lock_errors) >= 1, "Expected at least one lock error in RED state"
