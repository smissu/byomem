"""Tests for core.db_writer -- single-writer queue for SQLite."""

import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _noop_schema(conn: sqlite3.Connection) -> None:
    """Minimal schema init that avoids pulling in real config / code_index."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    """)
    conn.commit()


@pytest.fixture()
def writer(tmp_path):
    """Yield a fresh CodeDBWriter with a trivial schema, then shut it down."""
    from core.db_writer import CodeDBWriter

    db_path = tmp_path / "test.db"
    w = CodeDBWriter(db_path, schema_init=_noop_schema)
    yield w
    if not w.closed:
        w.shutdown()


@pytest.fixture()
def db_path(tmp_path):
    """Return a unique db path inside tmp_path (no writer created yet)."""
    return tmp_path / "singleton.db"


# ---------------------------------------------------------------------------
# 1. Basic write + read
# ---------------------------------------------------------------------------

class TestBasicWriteRead:
    def test_execute_insert_and_select(self, writer):
        """INSERT via writer, then SELECT via writer returns the row."""
        writer.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ("foo", "bar"))
        writer.commit()
        rows = writer.execute("SELECT value FROM kv WHERE key = ?", ("foo",))
        assert rows == [("bar",)]

    def test_executemany(self, writer):
        """executemany inserts multiple rows in one call."""
        data = [("a", "1"), ("b", "2"), ("c", "3")]
        writer.executemany("INSERT INTO kv (key, value) VALUES (?, ?)", data)
        writer.commit()
        rows = writer.execute("SELECT key FROM kv ORDER BY key")
        assert rows == [("a",), ("b",), ("c",)]

    def test_execute_batch_is_atomic(self, writer):
        """execute_batch commits all statements as one transaction."""
        ops = [
            ("INSERT INTO kv (key, value) VALUES (?, ?)", ("x", "10")),
            ("INSERT INTO kv (key, value) VALUES (?, ?)", ("y", "20")),
        ]
        writer.execute_batch(ops)
        rows = writer.execute("SELECT key, value FROM kv ORDER BY key")
        assert rows == [("x", "10"), ("y", "20")]


# ---------------------------------------------------------------------------
# 2. Concurrent submits from multiple threads
# ---------------------------------------------------------------------------

class TestConcurrency:
    def test_concurrent_inserts_no_error(self, writer):
        """Many threads inserting concurrently should all succeed."""
        n_threads = 20
        n_per_thread = 50
        errors = []

        def insert_range(thread_id):
            try:
                for i in range(n_per_thread):
                    key = f"t{thread_id}_i{i}"
                    writer.execute(
                        "INSERT INTO kv (key, value) VALUES (?, ?)",
                        (key, str(thread_id)),
                    )
            except Exception as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=insert_range, args=(tid,))
            for tid in range(n_threads)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"Concurrent inserts raised: {errors}"

        writer.commit()
        rows = writer.execute("SELECT COUNT(*) FROM kv")
        assert rows == [(n_threads * n_per_thread,)]

    def test_concurrent_submit_with_pool(self, writer):
        """ThreadPoolExecutor submits should serialize without locking errors."""
        def work(n):
            writer.execute(
                "INSERT INTO kv (key, value) VALUES (?, ?)",
                (f"pool_{n}", str(n)),
            )
            return n

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(work, range(100)))

        assert sorted(results) == list(range(100))
        writer.commit()
        rows = writer.execute("SELECT COUNT(*) FROM kv")
        assert rows == [(100,)]


# ---------------------------------------------------------------------------
# 3. submit() with complex function
# ---------------------------------------------------------------------------

class TestSubmit:
    def test_submit_complex_function(self, writer):
        """submit() can run multi-statement logic and return a value."""
        def complex_op(conn):
            conn.execute("INSERT INTO kv (key, value) VALUES ('alpha', '1')")
            conn.execute("INSERT INTO kv (key, value) VALUES ('beta', '2')")
            conn.commit()
            cur = conn.execute("SELECT SUM(CAST(value AS INTEGER)) FROM kv")
            return cur.fetchone()[0]

        total = writer.submit(complex_op)
        assert total == 3

    def test_submit_propagates_exception(self, writer):
        """If the submitted function raises, the caller sees the exception."""
        def bad_op(conn):
            raise ValueError("intentional error")

        with pytest.raises(ValueError, match="intentional error"):
            writer.submit(bad_op)

    def test_submit_after_error_still_works(self, writer):
        """The writer thread continues working after a failed op."""
        def bad_op(conn):
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            writer.submit(bad_op)

        # Subsequent operation should still work
        writer.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ("ok", "yes"))
        writer.commit()
        rows = writer.execute("SELECT value FROM kv WHERE key = 'ok'")
        assert rows == [("yes",)]


# ---------------------------------------------------------------------------
# 4. Shutdown is clean
# ---------------------------------------------------------------------------

class TestShutdown:
    def test_shutdown_sets_closed(self, writer):
        """After shutdown, closed property is True."""
        assert not writer.closed
        writer.shutdown()
        assert writer.closed

    def test_submit_after_shutdown_raises(self, writer):
        """Operations after shutdown should raise RuntimeError."""
        writer.shutdown()
        with pytest.raises(RuntimeError, match="shut down"):
            writer.execute("INSERT INTO kv (key, value) VALUES ('a', 'b')")

    def test_double_shutdown_is_safe(self, writer):
        """Calling shutdown twice should not raise."""
        writer.shutdown()
        writer.shutdown()  # no error

    def test_pending_writes_are_drained_on_shutdown(self, tmp_path):
        """Writes queued before shutdown should be executed."""
        from core.db_writer import CodeDBWriter

        db_path = tmp_path / "drain.db"
        w = CodeDBWriter(db_path, schema_init=_noop_schema)

        # Queue several writes
        for i in range(10):
            w.execute(
                "INSERT INTO kv (key, value) VALUES (?, ?)",
                (f"drain_{i}", str(i)),
            )

        w.shutdown()

        # Verify all writes landed by opening a direct connection
        conn = sqlite3.connect(str(db_path))
        rows = conn.execute("SELECT COUNT(*) FROM kv").fetchone()
        conn.close()
        assert rows[0] == 10


# ---------------------------------------------------------------------------
# 5. get_reader() returns working read connection
# ---------------------------------------------------------------------------

class TestReader:
    def test_reader_sees_committed_data(self, writer):
        """A reader connection should see data committed by the writer."""
        writer.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ("r", "read_me"))
        writer.commit()

        reader = writer.get_reader()
        try:
            rows = reader.execute("SELECT value FROM kv WHERE key = 'r'").fetchall()
            assert rows == [("read_me",)]
        finally:
            reader.close()

    def test_reader_is_readonly(self, writer):
        """Reader connection should reject write operations."""
        reader = writer.get_reader()
        try:
            with pytest.raises(sqlite3.OperationalError):
                reader.execute("INSERT INTO kv (key, value) VALUES ('x', 'y')")
        finally:
            reader.close()

    def test_multiple_readers_independent(self, writer):
        """Multiple reader connections should work independently."""
        writer.execute("INSERT INTO kv (key, value) VALUES (?, ?)", ("m", "multi"))
        writer.commit()

        r1 = writer.get_reader()
        r2 = writer.get_reader()
        try:
            assert r1.execute("SELECT value FROM kv WHERE key='m'").fetchone() == ("multi",)
            assert r2.execute("SELECT value FROM kv WHERE key='m'").fetchone() == ("multi",)
        finally:
            r1.close()
            r2.close()


# ---------------------------------------------------------------------------
# 6. get_writer() returns singleton
# ---------------------------------------------------------------------------

class TestSingleton:
    def test_get_writer_returns_same_instance(self, db_path):
        """get_writer() for the same path should return the same object."""
        from core.db_writer import get_writer, shutdown_writer

        try:
            w1 = get_writer(db_path, schema_init=_noop_schema)
            w2 = get_writer(db_path, schema_init=_noop_schema)
            assert w1 is w2
        finally:
            shutdown_writer(db_path)

    def test_get_writer_different_paths_are_different(self, tmp_path):
        """get_writer() for different paths should return different objects."""
        from core.db_writer import get_writer, shutdown_writer

        p1 = tmp_path / "a.db"
        p2 = tmp_path / "b.db"
        try:
            w1 = get_writer(p1, schema_init=_noop_schema)
            w2 = get_writer(p2, schema_init=_noop_schema)
            assert w1 is not w2
        finally:
            shutdown_writer(p1)
            shutdown_writer(p2)

    def test_shutdown_writer_allows_recreation(self, db_path):
        """After shutdown_writer, get_writer should create a fresh instance."""
        from core.db_writer import get_writer, shutdown_writer

        try:
            w1 = get_writer(db_path, schema_init=_noop_schema)
            shutdown_writer(db_path)
            assert w1.closed
            w2 = get_writer(db_path, schema_init=_noop_schema)
            assert w2 is not w1
            assert not w2.closed
        finally:
            shutdown_writer(db_path)

    def test_shutdown_all_cleans_everything(self, tmp_path):
        """shutdown_all should close all active writers."""
        from core.db_writer import get_writer, shutdown_all

        p1 = tmp_path / "all1.db"
        p2 = tmp_path / "all2.db"
        w1 = get_writer(p1, schema_init=_noop_schema)
        w2 = get_writer(p2, schema_init=_noop_schema)

        shutdown_all()
        assert w1.closed
        assert w2.closed

    def test_get_writer_resolves_paths(self, db_path):
        """Relative and absolute refs to the same file should share a writer."""
        from core.db_writer import get_writer, shutdown_writer

        # Create a relative-looking path that resolves to the same file
        rel_path = db_path.parent / "." / db_path.name
        try:
            w1 = get_writer(db_path, schema_init=_noop_schema)
            w2 = get_writer(rel_path, schema_init=_noop_schema)
            assert w1 is w2
        finally:
            shutdown_writer(db_path)
