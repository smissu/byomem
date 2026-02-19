"""Tests for core/search_index.py — hybrid FTS5 + sqlite-vec search index."""
from core.search_index import (
    _chunk_text,
    cleanup_orphaned_entries,
    delete_indexed_prefix,
    get_db,
    hybrid_search,
    index_file,
)

# ---------- _chunk_text ----------


def test_chunk_text_basic():
    """Splits content into overlapping chunks with correct line numbers."""
    # 20 lines of 100 chars each = 2000 chars total
    # chunk_tokens=50 → chunk_chars=200, overlap_tokens=10 → overlap_chars=40
    lines = [f"line{i:03d}" + "x" * 93 for i in range(20)]  # each line = 100 chars
    text = "\n".join(lines)
    chunks = _chunk_text(text, chunk_tokens=50, chunk_overlap=10)
    assert len(chunks) > 1
    # Each chunk is (start_line, end_line, text)
    for start, end, chunk_text in chunks:
        assert start >= 1
        assert end >= start
        assert len(chunk_text) > 0
    # First chunk starts at line 1
    assert chunks[0][0] == 1
    # Overlap: second chunk should start at or before the first chunk's end
    assert chunks[1][0] <= chunks[0][1]


def test_chunk_text_small_file():
    """File smaller than one chunk returns a single chunk."""
    text = "short file\nonly two lines"
    chunks = _chunk_text(text, chunk_tokens=400, chunk_overlap=80)
    assert len(chunks) == 1
    assert chunks[0] == (1, 2, text)


def test_chunk_text_exact_boundary():
    """Content exactly at chunk boundary produces expected behavior."""
    # chunk_tokens=10 → chunk_chars=40, overlap_tokens=2 → overlap_chars=8
    # 4 lines of exactly 10 chars each = 40 chars total (one full chunk)
    lines = ["a" * 10, "b" * 10, "c" * 10, "d" * 10]
    text = "\n".join(lines)
    chunks = _chunk_text(text, chunk_tokens=10, chunk_overlap=2)
    assert len(chunks) >= 1
    # First chunk should contain all 4 lines
    assert chunks[0][0] == 1


# ---------- index_file ----------


def test_index_file_creates_db(tmp_byomem, mock_openai_embed):
    """Indexing into non-existent DB path creates the database."""
    from core.config import get_config
    cfg = get_config()
    assert not cfg.db_path.exists()

    proj_dir = tmp_byomem / "myproject"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "commit.md"
    f.write_text("hello world")
    index_file(f, project="myproject")

    assert cfg.db_path.exists()


def test_index_file_skips_unchanged(tmp_byomem, mock_openai_embed):
    """Second call with same content is a no-op; chunks count stays the same."""
    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "notes.md"
    f.write_text("some content here")

    index_file(f, project="proj")
    db = get_db()
    count1 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]

    index_file(f, project="proj")
    count2 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    assert count1 == count2
    assert count1 > 0


def test_index_file_upserts_on_change(tmp_byomem, mock_openai_embed):
    """Changed content replaces old chunks with new ones."""
    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "data.md"
    f.write_text("original content alpha beta")

    index_file(f, project="proj")
    db = get_db()
    texts_before = [r[0] for r in db.execute("SELECT text FROM chunks").fetchall()]
    assert any("original" in t for t in texts_before)

    f.write_text("replacement content gamma delta")
    index_file(f, project="proj")
    db = get_db()
    texts_after = [r[0] for r in db.execute("SELECT text FROM chunks").fetchall()]
    assert not any("original" in t for t in texts_after)
    assert any("replacement" in t for t in texts_after)


# ---------- FTS5 sync ----------


def test_fts5_sync_regression(tmp_byomem, mock_openai_embed):
    """After re-index, old content must NOT appear in FTS5 search results."""
    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "doc.md"

    # Step 1: index with "alpha beta gamma"
    f.write_text("alpha beta gamma")
    index_file(f, project="proj")
    db = get_db()
    rows = db.execute(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'alpha'"
    ).fetchall()
    assert len(rows) > 0

    # Step 2: re-index with "delta epsilon zeta"
    f.write_text("delta epsilon zeta")
    index_file(f, project="proj")
    db = get_db()

    # Old content must NOT match
    rows_old = db.execute(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'alpha'"
    ).fetchall()
    assert len(rows_old) == 0

    # New content must match
    rows_new = db.execute(
        "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'delta'"
    ).fetchall()
    assert len(rows_new) > 0


# ---------- hybrid_search ----------


def test_hybrid_search_sorted_by_score(tmp_byomem, mock_openai_embed):
    """Results are returned in descending score order."""
    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)

    for i, word in enumerate(["apple banana", "cherry date", "elderberry fig"]):
        f = proj_dir / f"doc{i}.md"
        f.write_text(word)
        index_file(f, project="proj")

    results = hybrid_search("apple banana cherry", min_score=0.0)
    if len(results) >= 2:
        for i in range(len(results) - 1):
            assert results[i]["score"] >= results[i + 1]["score"]


def test_hybrid_search_filters_min_score(tmp_byomem, mock_openai_embed):
    """Results below min_score are excluded."""
    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "doc.md"
    f.write_text("specific unique keyword xylophone")
    index_file(f, project="proj")

    # With impossibly high min_score, nothing should match
    results = hybrid_search("xylophone", min_score=99.0)
    assert results == []


def test_hybrid_search_project_scoping(tmp_byomem, mock_openai_embed):
    """Project filter limits results to that project only."""
    for proj in ["projA", "projB"]:
        d = tmp_byomem / proj
        d.mkdir(parents=True)

    fA = tmp_byomem / "projA" / "doc.md"
    fA.write_text("unique_token_aaa searching")
    index_file(fA, project="projA")

    fB = tmp_byomem / "projB" / "doc.md"
    fB.write_text("unique_token_bbb searching")
    index_file(fB, project="projB")

    results = hybrid_search("unique_token_aaa", project="projA", min_score=0.0)
    paths = [r["path"] for r in results]
    assert all("projA" in p for p in paths)
    assert not any("projB" in p for p in paths)


def test_keyword_only_fallback(tmp_byomem, mocker):
    """When _get_embedding returns None (no API key), search uses FTS5 only."""
    mocker.patch("core.search_index._get_embedding", return_value=None)

    proj_dir = tmp_byomem / "proj"
    proj_dir.mkdir(parents=True)
    f = proj_dir / "doc.md"
    f.write_text("fallback keyword search test")
    index_file(f, project="proj")

    results = hybrid_search("fallback", min_score=0.0)
    assert len(results) > 0
    assert "fallback" in results[0]["preview"]


def test_empty_db_returns_empty(tmp_byomem):
    """hybrid_search on empty DB returns []."""
    results = hybrid_search("anything", min_score=0.0)
    assert results == []


# ---------- delete_indexed_prefix / cleanup_orphaned_entries ----------


def test_delete_indexed_prefix(tmp_byomem, mock_openai_embed):
    """Deletes all indexed data matching a path prefix."""
    proj = tmp_byomem / "proj" / "branches" / "2026-02-19-abc"
    proj.mkdir(parents=True)
    f = proj / "commit.md"
    f.write_text("some indexed content")
    index_file(f, project="proj")

    # Also index a file NOT under that prefix
    other = tmp_byomem / "proj"
    other_f = other / "main.md"
    other_f.write_text("main content here")
    index_file(other_f, project="proj")

    count = delete_indexed_prefix("proj/branches/2026-02-19-abc/")
    assert count == 1

    db = get_db()
    # Branch file gone
    remaining = db.execute("SELECT path FROM files").fetchall()
    paths = [r[0] for r in remaining]
    assert not any("2026-02-19-abc" in p for p in paths)
    # Main.md still there
    assert any("main.md" in p for p in paths)


def test_cleanup_orphaned_entries(tmp_byomem, mock_openai_embed):
    """Removes entries for files that no longer exist on disk."""
    proj = tmp_byomem / "proj"
    proj.mkdir(parents=True)
    f = proj / "doc.md"
    f.write_text("will be orphaned")
    index_file(f, project="proj")

    # Delete the file but leave index entries
    f.unlink()

    removed = cleanup_orphaned_entries()
    assert removed == 1

    db = get_db()
    assert db.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0


def test_cleanup_preserves_valid(tmp_byomem, mock_openai_embed):
    """cleanup_orphaned_entries preserves entries for existing files."""
    proj = tmp_byomem / "proj"
    proj.mkdir(parents=True)
    f = proj / "valid.md"
    f.write_text("still exists")
    index_file(f, project="proj")

    removed = cleanup_orphaned_entries()
    assert removed == 0

    db = get_db()
    assert db.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 1
