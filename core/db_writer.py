"""Single-writer queue for SQLite database access.

Serializes all write operations through a dedicated thread, eliminating
"database is locked" errors from concurrent writers. Read connections use
WAL mode for concurrent read access.
"""

import atexit
import logging
import queue
import sqlite3
import threading
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class _WriteOp:
    """A unit of work submitted to the writer thread."""

    fn: Callable[[sqlite3.Connection], Any]
    future: Future = field(default_factory=Future)


class CodeDBWriter:
    """Single-writer queue for SQLite. All writes go through one thread."""

    _SENTINEL = object()  # signals the writer thread to exit

    def __init__(
        self,
        db_path: Path,
        schema_init: Callable[[sqlite3.Connection], None] | None = None,
    ):
        """Open a write connection and start the writer thread.

        Args:
            db_path: Path to the SQLite database file.
            schema_init: Optional callable that receives the write connection
                and initialises the schema.  If *None*, the default code_index
                schema is used (core.code_index._init_schema).
        """
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._queue: queue.Queue[_WriteOp | object] = queue.Queue()
        self._closed = False
        self._lock = threading.Lock()  # guards _closed flag

        # Open the write connection on the current thread, then hand it off
        # to the writer thread.  We need it here briefly to run schema init.
        conn = self._make_write_connection()

        # Schema initialisation
        if schema_init is not None:
            schema_init(conn)
        else:
            self._default_schema_init(conn)

        self._conn = conn  # only touched by the writer thread after start

        self._thread = threading.Thread(
            target=self._writer_loop,
            name=f"db-writer-{self._db_path.name}",
            daemon=True,
        )
        self._thread.start()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------

    def _make_write_connection(self) -> sqlite3.Connection:
        """Create a WAL-mode write connection with sqlite_vec loaded."""
        conn = sqlite3.connect(
            str(self._db_path),
            timeout=30,
            check_same_thread=False,
        )
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        self._load_vec_extension(conn)
        return conn

    @staticmethod
    def _load_vec_extension(conn: sqlite3.Connection) -> None:
        """Attempt to load the sqlite_vec extension; silently skip if unavailable."""
        try:
            import sqlite_vec

            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
        except Exception:
            pass

    def _default_schema_init(self, conn: sqlite3.Connection) -> None:
        """Run the code_index schema init on conn."""
        from core.code_index import _init_schema
        from core.config import get_config

        cfg = get_config()
        dim = cfg.code_embedding_dimension or cfg.embedding_dimension

        # Detect whether vec is available on this connection
        vec_available = False
        try:
            import sqlite_vec  # noqa: F401, F811
            vec_available = True
        except Exception:
            pass

        _init_schema(conn, dim, vec_available)

    # ------------------------------------------------------------------
    # Writer thread
    # ------------------------------------------------------------------

    def _writer_loop(self) -> None:
        """Main loop: pull operations from the queue and execute them."""
        conn = self._conn
        while True:
            item = self._queue.get()
            if item is self._SENTINEL:
                # Drain remaining items (best-effort) before exiting
                while not self._queue.empty():
                    try:
                        remaining = self._queue.get_nowait()
                    except queue.Empty:
                        break
                    if remaining is self._SENTINEL:
                        continue
                    self._execute_op(conn, remaining)
                try:
                    conn.commit()
                except Exception:
                    pass
                try:
                    conn.close()
                except Exception:
                    pass
                break

            op: _WriteOp = item  # type: ignore[assignment]
            self._execute_op(conn, op)

    @staticmethod
    def _execute_op(conn: sqlite3.Connection, op: _WriteOp) -> None:
        """Execute a single _WriteOp, setting its future result or exception."""
        try:
            result = op.fn(conn)
            op.future.set_result(result)
        except Exception as exc:
            op.future.set_exception(exc)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def submit(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Submit an arbitrary function that receives the write connection.

        Blocks until complete.  Returns the function's return value.
        This is the most flexible API -- use for complex multi-statement
        operations.
        """
        with self._lock:
            if self._closed:
                raise RuntimeError("CodeDBWriter is shut down")
        op = _WriteOp(fn=fn)
        self._queue.put(op)
        return op.future.result()

    def execute(self, sql: str, params: tuple = ()) -> Any:
        """Submit a single SQL statement.  Blocks until executed.

        Returns the cursor result rows as a list so the cursor
        can be reused safely across threads.
        """

        def _exec(conn: sqlite3.Connection):
            cur = conn.execute(sql, params)
            return cur.fetchall()

        return self.submit(_exec)

    def executemany(self, sql: str, params_seq) -> None:
        """Submit executemany.  Blocks until done."""

        def _execmany(conn: sqlite3.Connection):
            conn.executemany(sql, params_seq)

        self.submit(_execmany)

    def execute_batch(self, operations: list[tuple[str, tuple]]) -> None:
        """Submit multiple SQL statements as one atomic transaction."""

        def _batch(conn: sqlite3.Connection):
            for sql, params in operations:
                conn.execute(sql, params)
            conn.commit()

        self.submit(_batch)

    def commit(self) -> None:
        """Force a commit on the writer thread."""

        def _commit(conn: sqlite3.Connection):
            conn.commit()

        self.submit(_commit)

    def get_reader(self) -> sqlite3.Connection:
        """Return a read-only connection (WAL allows concurrent reads).

        Caller is responsible for closing it.
        """
        conn = sqlite3.connect(
            str(self._db_path),
            timeout=10,
            check_same_thread=False,
        )
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA query_only=ON")
        self._load_vec_extension(conn)
        return conn

    def shutdown(self) -> None:
        """Drain the queue, commit, close the connection, stop the thread."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._queue.put(self._SENTINEL)
        self._thread.join(timeout=10)

    @property
    def closed(self) -> bool:
        """Whether the writer has been shut down."""
        return self._closed


# ======================================================================
# Module-level singleton management
# ======================================================================

_writers: dict[str, CodeDBWriter] = {}
_writers_lock = threading.Lock()


def get_writer(
    db_path,
    schema_init: Callable[[sqlite3.Connection], None] | None = None,
) -> CodeDBWriter:
    """Get or create the CodeDBWriter singleton for a given db_path.

    Uses the resolved absolute path as the key so that different relative
    references to the same file share a single writer.
    """
    key = str(Path(db_path).resolve())
    with _writers_lock:
        writer = _writers.get(key)
        if writer is not None and not writer.closed:
            return writer
        writer = CodeDBWriter(db_path, schema_init=schema_init)
        _writers[key] = writer
        return writer


def shutdown_writer(db_path) -> None:
    """Shutdown the writer for a given db_path if it exists."""
    key = str(Path(db_path).resolve())
    with _writers_lock:
        writer = _writers.pop(key, None)
    if writer is not None:
        writer.shutdown()


def shutdown_all() -> None:
    """Shutdown all active writers.  Call at process exit."""
    with _writers_lock:
        writers = list(_writers.values())
        _writers.clear()
    for w in writers:
        try:
            w.shutdown()
        except Exception:
            pass


atexit.register(shutdown_all)
