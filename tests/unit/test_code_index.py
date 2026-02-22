"""Tests for core/code_index.py — source code indexing with FTS5 + sqlite-vec.

Covers two task groups:
  Task 0.2 — core code_index functions (schema, hashing, chunking, search, delete)
  Task 0.4 — git change detection (diff parsing, sha tracking, edge cases)
"""

import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------- fixtures ----------


@pytest.fixture
def mock_code_embedding(mocker):
    """Patch embedding functions to return fixed vectors.

    _get_embedding is still used by code_search() for query embedding.
    _get_embeddings_batch is used by index_source_file() after two-phase refactor.
    """
    mocker.patch("core.code_index._get_embedding", return_value=[0.1] * 1536)
    mocker.patch(
        "core.code_index._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.1] * 1536, True)] * len(texts),
    )


# ============================================================
# TASK 0.2 — core code_index functions
# ============================================================


# ---------- AC-1: get_code_db schema ----------


def test_get_code_db_creates_schema(tmp_byomem, tmp_path):
    """get_code_db() creates code.db with expected tables: files, chunks, chunks_fts,
    chunks_vec, embedding_cache."""
    from core.code_index import get_code_db

    db_path = tmp_path / "code.db"
    db = get_code_db(db_path)
    tables = {
        r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert "files" in tables
    assert "chunks" in tables
    assert "chunks_fts" in tables
    assert "embedding_cache" in tables
    # chunks_vec requires sqlite_vec extension — only assert if available
    try:
        import sqlite_vec  # noqa: F401

        all_objects = {r[0] for r in db.execute("SELECT name FROM sqlite_master").fetchall()}
        assert "chunks_vec" in all_objects
    except ImportError:
        pass
    db.close()


def test_get_code_db_uses_code_db_path_not_search_db(tmp_byomem, tmp_path):
    """get_code_db() connects to the code_db_path, NOT search.db."""
    from core.code_index import get_code_db

    code_db = tmp_path / "code.db"
    db = get_code_db(code_db)
    db.close()

    assert code_db.exists()
    # search.db should NOT have been created as a side effect
    from core.config import get_config

    cfg = get_config()
    assert not cfg.db_path.exists(), "search.db must not be created by get_code_db"


# ---------- AC-2: index_source_file skips unchanged ----------


def test_index_source_file_skips_unchanged(tmp_byomem, tmp_path, mock_code_embedding):
    """Second call with identical content is a no-op; chunk count stays the same."""
    from core.code_index import get_code_db, index_source_file

    db_path = tmp_path / "code.db"
    src = tmp_path / "app.py"
    src.write_text("def hello():\n    return 'hi'\n")

    index_source_file(src, "myproject", db_path)
    db = get_code_db(db_path)
    count1 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    db.close()

    index_source_file(src, "myproject", db_path)
    db = get_code_db(db_path)
    count2 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    db.close()

    assert count1 == count2
    assert count1 > 0


# ---------- AC-3: index_source_file upserts changed ----------


def test_index_source_file_upserts_on_change(tmp_byomem, tmp_path, mock_code_embedding):
    """Changed content replaces old chunks; old text is gone, new text present."""
    from core.code_index import get_code_db, index_source_file

    db_path = tmp_path / "code.db"
    src = tmp_path / "module.py"
    src.write_text("def original():\n    pass\n")

    index_source_file(src, "myproject", db_path)
    db = get_code_db(db_path)
    texts_before = [r[0] for r in db.execute("SELECT text FROM chunks").fetchall()]
    db.close()
    assert any("original" in t for t in texts_before)

    src.write_text("def replacement():\n    pass\n")
    index_source_file(src, "myproject", db_path)
    db = get_code_db(db_path)
    texts_after = [r[0] for r in db.execute("SELECT text FROM chunks").fetchall()]
    db.close()
    assert not any("original" in t for t in texts_after)
    assert any("replacement" in t for t in texts_after)


# ---------- AC-4: _chunk_code Python def/class boundaries ----------


def test_chunk_code_python_splits_on_def_class(tmp_path):
    """Python files are split on def/class boundaries; method chunks include parent
    class declaration as header."""
    from core.code_index import _chunk_code

    source = (
        "class MyService:\n"
        "    '''Service docstring.'''\n"
        "\n"
        "    def method_a(self):\n"
        "        return 1\n"
        "\n"
        "    def method_b(self):\n"
        "        return 2\n"
        "\n"
        "def standalone_func():\n"
        "    pass\n"
    )

    chunks = _chunk_code(source, "service.py")
    texts = [c[2] if len(c) == 3 else c for c in chunks]

    # Should produce at least 3 chunks: class+method_a, method_b, standalone_func
    assert len(chunks) >= 3

    # Each method chunk inside the class should include the parent class header
    method_b_chunks = [t for t in texts if "method_b" in t]
    assert len(method_b_chunks) >= 1
    # The method_b chunk should reference the parent class
    assert any("class MyService" in t or "MyService" in t for t in method_b_chunks)


def test_chunk_code_python_top_level_defs(tmp_path):
    """Top-level def boundaries produce separate chunks."""
    from core.code_index import _chunk_code

    source = (
        "def func_alpha():\n"
        "    return 'alpha'\n"
        "\n"
        "def func_beta():\n"
        "    return 'beta'\n"
        "\n"
        "def func_gamma():\n"
        "    return 'gamma'\n"
    )

    chunks = _chunk_code(source, "funcs.py")
    texts = [c[2] if len(c) == 3 else c for c in chunks]

    assert len(chunks) >= 3
    assert any("func_alpha" in t for t in texts)
    assert any("func_beta" in t for t in texts)
    assert any("func_gamma" in t for t in texts)


# ---------- AC-5: _chunk_code generic fallback for non-Python ----------


def test_chunk_code_non_python_fallback(tmp_path):
    """Non-Python files use generic line-based chunker."""
    from core.code_index import _chunk_code

    source = "const x = 1;\nconst y = 2;\nfunction foo() { return x + y; }\n"

    chunks = _chunk_code(source, "app.js")
    assert len(chunks) >= 1
    # Each chunk is a (start_line, end_line, text) tuple
    for chunk in chunks:
        assert len(chunk) == 3
        start, end, text = chunk
        assert isinstance(start, int)
        assert isinstance(end, int)
        assert isinstance(text, str)
        assert len(text) > 0


def test_chunk_code_markdown_uses_generic(tmp_path):
    """Markdown files also use the generic fallback, not Python splitter."""
    from core.code_index import _chunk_code

    source = "# Heading\n\nSome content.\n\n## Subheading\n\nMore content.\n"

    chunks = _chunk_code(source, "README.md")
    assert len(chunks) >= 1
    full_text = " ".join(c[2] for c in chunks)
    assert "Heading" in full_text
    assert "Subheading" in full_text


# ---------- AC-6: code_search project namespace filtering ----------


def test_code_search_filters_by_project(tmp_byomem, tmp_path, mock_code_embedding):
    """code_search returns results scoped to the correct project namespace;
    memory search.db is never touched."""
    from core.code_index import code_search, index_source_file

    db_path = tmp_path / "code.db"

    # Index files for two projects
    src_a = tmp_path / "proj_a.py"
    src_a.write_text("def unique_alpha_func():\n    return 'alpha'\n")
    index_source_file(src_a, "project_alpha", db_path)

    src_b = tmp_path / "proj_b.py"
    src_b.write_text("def unique_beta_func():\n    return 'beta'\n")
    index_source_file(src_b, "project_beta", db_path)

    results = code_search("unique_alpha_func", project="project_alpha", db_path=db_path)
    paths = [r["path"] for r in results]
    assert any("proj_a" in p for p in paths)
    assert not any("proj_b" in p for p in paths)

    # Verify memory search.db was not created or touched
    from core.config import get_config

    cfg = get_config()
    assert not cfg.db_path.exists(), "code_search must not touch search.db"


def test_code_search_returns_empty_for_wrong_project(tmp_byomem, tmp_path, mock_code_embedding):
    """Searching for content in the wrong project namespace returns nothing."""
    from core.code_index import code_search, index_source_file

    db_path = tmp_path / "code.db"
    src = tmp_path / "only_here.py"
    src.write_text("def only_in_alpha():\n    pass\n")
    index_source_file(src, "alpha", db_path)

    results = code_search("only_in_alpha", project="beta", db_path=db_path)
    assert results == []


# ---------- AC-7: delete_indexed_source_file ----------


def test_delete_indexed_source_file_removes_all(tmp_byomem, tmp_path, mock_code_embedding):
    """delete_indexed_source_file removes all chunks and FTS5 entries for a path."""
    from core.code_index import delete_indexed_source_file, get_code_db, index_source_file

    db_path = tmp_path / "code.db"
    src = tmp_path / "to_delete.py"
    src.write_text("def will_be_deleted():\n    pass\n")
    index_source_file(src, "myproject", db_path)

    db = get_code_db(db_path)
    assert db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] > 0
    db.close()

    delete_indexed_source_file(str(src), "myproject", db_path)

    db = get_code_db(db_path)
    assert db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0
    db.close()


def test_delete_indexed_source_file_noop_on_missing(tmp_byomem, tmp_path, mock_code_embedding):
    """delete_indexed_source_file on a path that was never indexed is a no-op (no error)."""
    from core.code_index import delete_indexed_source_file, get_code_db

    db_path = tmp_path / "code.db"
    # Ensure DB exists
    db = get_code_db(db_path)
    db.close()

    # Should not raise
    delete_indexed_source_file("/nonexistent/file.py", "myproject", db_path)


def test_delete_indexed_source_file_preserves_other_files(
    tmp_byomem, tmp_path, mock_code_embedding
):
    """Deleting one file's index leaves other files' chunks intact."""
    from core.code_index import delete_indexed_source_file, get_code_db, index_source_file

    db_path = tmp_path / "code.db"

    keep = tmp_path / "keep.py"
    keep.write_text("def keep_me():\n    pass\n")
    index_source_file(keep, "myproject", db_path)

    remove = tmp_path / "remove.py"
    remove.write_text("def remove_me():\n    pass\n")
    index_source_file(remove, "myproject", db_path)

    delete_indexed_source_file(str(remove), "myproject", db_path)

    db = get_code_db(db_path)
    remaining = [r[0] for r in db.execute("SELECT text FROM chunks").fetchall()]
    db.close()
    assert any("keep_me" in t for t in remaining)
    assert not any("remove_me" in t for t in remaining)


# ============================================================
# TASK 0.4 — git change detection
# ============================================================


# ---------- AC-1: get_changed_source_files parses git diff ----------


def test_get_changed_files_parses_diff(tmp_path, mocker):
    """Parses git diff --name-status output into (Path, status) tuples."""
    mocker.patch(
        "core.code_index.subprocess.run",
        return_value=MagicMock(
            returncode=0,
            stdout="M\tcore/foo.py\nA\tcore/bar.py\nD\tcore/old.py\n",
        ),
    )
    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    assert (tmp_path / "core/foo.py", "M") in results
    assert (tmp_path / "core/bar.py", "A") in results
    assert (tmp_path / "core/old.py", "D") in results


def test_get_changed_files_returns_path_objects(tmp_path, mocker):
    """Returned paths are Path objects, not strings."""
    mocker.patch(
        "core.code_index.subprocess.run",
        return_value=MagicMock(
            returncode=0,
            stdout="A\tsrc/new.py\n",
        ),
    )
    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    assert len(results) == 1
    path, status = results[0]
    assert isinstance(path, Path)
    assert status == "A"


# ---------- AC-2: get_last_indexed_sha ----------


def test_get_last_indexed_sha_returns_stored(tmp_byomem, tmp_path):
    """Returns the sha stored in code.db meta table."""
    from core.code_index import get_last_indexed_sha, set_last_indexed_sha

    db_path = tmp_path / "code.db"
    # First ensure the DB and meta table exist
    set_last_indexed_sha("myproject", "deadbeef1234", db_path)

    sha = get_last_indexed_sha("myproject", db_path)
    assert sha == "deadbeef1234"


def test_get_last_indexed_sha_returns_none_if_never_indexed(tmp_byomem, tmp_path):
    """Returns None when no sha has been stored for this project."""
    from core.code_index import get_code_db, get_last_indexed_sha

    db_path = tmp_path / "code.db"
    # Create DB but don't set any sha
    db = get_code_db(db_path)
    db.close()

    sha = get_last_indexed_sha("myproject", db_path)
    assert sha is None


# ---------- AC-3: set_last_indexed_sha ----------


def test_set_last_indexed_sha_persists(tmp_byomem, tmp_path):
    """set_last_indexed_sha stores sha in code.db meta table, retrievable later."""
    from core.code_index import get_last_indexed_sha, set_last_indexed_sha

    db_path = tmp_path / "code.db"
    set_last_indexed_sha("projA", "sha_aaa", db_path)
    set_last_indexed_sha("projB", "sha_bbb", db_path)

    assert get_last_indexed_sha("projA", db_path) == "sha_aaa"
    assert get_last_indexed_sha("projB", db_path) == "sha_bbb"


def test_set_last_indexed_sha_overwrites(tmp_byomem, tmp_path):
    """Calling set_last_indexed_sha twice for the same project overwrites the old value."""
    from core.code_index import get_last_indexed_sha, set_last_indexed_sha

    db_path = tmp_path / "code.db"
    set_last_indexed_sha("proj", "sha_old", db_path)
    set_last_indexed_sha("proj", "sha_new", db_path)

    assert get_last_indexed_sha("proj", db_path) == "sha_new"


# ---------- AC-4: full reindex when last_sha is None ----------


def test_get_changed_files_full_reindex_when_no_sha(tmp_path, mocker):
    """When last_sha is None, returns all source files (full reindex path)."""
    # Create some files in the directory
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "main.py").write_text("print('hello')")
    (src_dir / "util.py").write_text("def helper(): pass")
    (tmp_path / "README.md").write_text("# readme")

    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, None)

    # Should include files without calling git diff
    assert len(results) > 0
    _paths = [p for p, _ in results]
    # All returned statuses should indicate addition (full index)
    statuses = [s for _, s in results]
    assert all(s == "A" for s in statuses)


# ---------- AC-5: empty list when no changes ----------


def test_get_changed_files_empty_when_no_changes(tmp_path, mocker):
    """Returns empty list when git diff shows no changed files since last_sha."""
    mocker.patch(
        "core.code_index.subprocess.run",
        return_value=MagicMock(
            returncode=0,
            stdout="",
        ),
    )
    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    assert results == []


# ---------- AC-6: files outside source_root excluded ----------


def test_get_changed_files_excludes_outside_root(tmp_path, mocker):
    """Files outside source_root are excluded from results."""
    mocker.patch(
        "core.code_index.subprocess.run",
        return_value=MagicMock(
            returncode=0,
            stdout="M\tcore/inside.py\nM\t../outside/sneaky.py\n",
        ),
    )
    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    paths = [str(p) for p, _ in results]

    # Only the file inside source_root should be returned
    assert any("inside.py" in p for p in paths)
    assert not any("sneaky" in p for p in paths)


def test_get_changed_files_excludes_absolute_paths_outside(tmp_path, mocker):
    """Absolute paths pointing outside source_root are filtered out."""
    mocker.patch(
        "core.code_index.subprocess.run",
        return_value=MagicMock(
            returncode=0,
            stdout="M\tgood.py\nM\t/etc/passwd\n",
        ),
    )
    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    paths = [str(p) for p, _ in results]
    assert any("good.py" in p for p in paths)
    assert not any("passwd" in p for p in paths)


# ---------- AC-7: graceful handling when not a git repo ----------


def test_get_changed_files_no_git_returns_all_files(tmp_path, mocker):
    """When source_root is not a git repo (CalledProcessError), returns full file list."""
    mocker.patch(
        "core.code_index.subprocess.run",
        side_effect=subprocess.CalledProcessError(128, "git"),
    )
    # Create some files
    (tmp_path / "alpha.py").write_text("x = 1")
    (tmp_path / "beta.py").write_text("y = 2")

    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    # Should return files without raising
    assert len(results) >= 2
    statuses = [s for _, s in results]
    assert all(s == "A" for s in statuses)


def test_get_changed_files_git_absent_returns_all_files(tmp_path, mocker):
    """When git is not installed (FileNotFoundError), returns full file list."""
    mocker.patch(
        "core.code_index.subprocess.run",
        side_effect=FileNotFoundError("git not found"),
    )
    (tmp_path / "only.py").write_text("z = 3")

    from core.code_index import get_changed_source_files

    results = get_changed_source_files(tmp_path, "abc123sha")
    assert len(results) >= 1
    statuses = [s for _, s in results]
    assert all(s == "A" for s in statuses)
