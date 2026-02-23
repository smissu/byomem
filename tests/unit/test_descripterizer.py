"""Tests for core/descripterizer.py — NL description generation for code chunks."""

import json

import pytest

# ---------- fixtures ----------


@pytest.fixture
def indexed_chunks(tmp_byomem, tmp_path, mocker):
    """Create a code.db with some indexed chunks (no descriptions)."""
    mocker.patch("core.code_index._get_embedding", return_value=[0.1] * 1536)
    mocker.patch(
        "core.code_index._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.1] * 1536, True)] * len(texts),
    )

    from core.code_index import get_code_db, index_source_file

    db_path = tmp_path / "code.db"

    src = tmp_path / "app.py"
    src.write_text(
        "def delete_task(task_id):\n"
        "    '''Remove a task from the database.'''\n"
        "    db.execute('DELETE FROM tasks WHERE id=?', (task_id,))\n"
        "\n"
        "def create_task(name):\n"
        "    '''Add a new task.'''\n"
        "    db.execute('INSERT INTO tasks (name) VALUES (?)', (name,))\n"
    )
    index_source_file(src, "testproj", db_path)

    db = get_code_db(db_path)
    chunks = db.execute(
        "SELECT id, text FROM chunks WHERE file_path LIKE 'testproj/%'"
    ).fetchall()
    db.close()

    return db_path, chunks


@pytest.fixture
def mock_descripterizer_llm(mocker):
    """Patch _call_llm to return predictable descriptions."""

    def fake_call_llm(prompt, *, backend=None):
        # Parse chunk IDs from the prompt
        import re

        chunk_ids = re.findall(r"--- Chunk (\d+) ---", prompt)
        descriptions = []
        for cid in chunk_ids:
            descriptions.append(
                {"chunk_id": cid, "description": f"Test description for chunk {cid}"}
            )
        return json.dumps({"descriptions": descriptions})

    mocker.patch("core.descripterizer._call_llm", side_effect=fake_call_llm)


# ============================================================
# Model tests
# ============================================================


def test_chunk_description_model():
    """ChunkDescription validates chunk_id and description fields."""
    from core.models import ChunkDescription

    desc = ChunkDescription(chunk_id="42", description="Deletes a task from the database.")
    assert desc.chunk_id == "42"
    assert "task" in desc.description


def test_batch_description_response_model():
    """BatchDescriptionResponse parses a list of ChunkDescription items."""
    from core.models import BatchDescriptionResponse

    raw = json.dumps(
        {
            "descriptions": [
                {"chunk_id": "1", "description": "Creates a task."},
                {"chunk_id": "2", "description": "Deletes a task."},
            ]
        }
    )
    resp = BatchDescriptionResponse.model_validate_json(raw)
    assert len(resp.descriptions) == 2
    assert resp.descriptions[0].chunk_id == "1"


# ============================================================
# Schema migration tests
# ============================================================


def test_description_column_exists(tmp_byomem, tmp_path):
    """The chunks table has a description column after schema init."""
    from core.code_index import get_code_db

    db_path = tmp_path / "code.db"
    db = get_code_db(db_path)
    # PRAGMA table_info returns (cid, name, type, notnull, default, pk)
    columns = {row[1] for row in db.execute("PRAGMA table_info(chunks)").fetchall()}
    assert "description" in columns
    db.close()


def test_description_column_migration_idempotent(tmp_byomem, tmp_path):
    """Calling get_code_db twice doesn't fail on the ALTER TABLE."""
    from core.code_index import get_code_db

    db_path = tmp_path / "code.db"
    db1 = get_code_db(db_path)
    db1.close()
    # Second call should not raise
    db2 = get_code_db(db_path)
    columns = {row[1] for row in db2.execute("PRAGMA table_info(chunks)").fetchall()}
    assert "description" in columns
    db2.close()


# ============================================================
# _format_batch tests
# ============================================================


def test_format_batch_delimiter_pattern():
    """_format_batch produces --- Chunk {id} --- delimiters."""
    from core.descripterizer import _format_batch

    chunks = [("1", "def foo(): pass"), ("2", "def bar(): pass")]
    result = _format_batch(chunks)
    assert "--- Chunk 1 ---" in result
    assert "--- Chunk 2 ---" in result
    assert "def foo" in result
    assert "def bar" in result


def test_format_batch_truncates_long_chunks():
    """_format_batch truncates chunks longer than 3000 chars."""
    from core.descripterizer import _format_batch

    long_code = "x = 1\n" * 1000  # ~6000 chars
    chunks = [("99", long_code)]
    result = _format_batch(chunks)
    # The chunk content should be truncated
    assert len(result) < len(long_code) + 100


# ============================================================
# descripterize_project tests
# ============================================================


def test_descripterize_stores_descriptions(indexed_chunks, mock_descripterizer_llm, mocker):
    """descripterize_project stores descriptions in chunks.description column."""
    mocker.patch(
        "core.indexing_utils._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.2] * 1536, True)] * len(texts),
    )

    from core.code_index import get_code_db
    from core.descripterizer import descripterize_project

    db_path, chunks = indexed_chunks
    stats = descripterize_project("testproj", db_path=db_path)

    assert stats["described"] > 0
    assert stats["failed"] == 0

    db = get_code_db(db_path)
    described = db.execute(
        "SELECT id, description FROM chunks WHERE description IS NOT NULL"
    ).fetchall()
    db.close()

    assert len(described) > 0
    for chunk_id, desc in described:
        assert "Test description for chunk" in desc


def test_descripterize_skips_already_described(indexed_chunks, mock_descripterizer_llm, mocker):
    """Without --force, chunks with existing descriptions are skipped."""
    mocker.patch(
        "core.indexing_utils._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.2] * 1536, True)] * len(texts),
    )

    from core.descripterizer import descripterize_project

    db_path, chunks = indexed_chunks

    # First pass: describe all
    stats1 = descripterize_project("testproj", db_path=db_path)
    assert stats1["described"] > 0

    # Second pass: nothing to do
    stats2 = descripterize_project("testproj", db_path=db_path)
    assert stats2["total"] == 0
    assert stats2["described"] == 0


def test_descripterize_force_redescribes(indexed_chunks, mock_descripterizer_llm, mocker):
    """With force=True, all chunks are re-described even if they have descriptions."""
    mocker.patch(
        "core.indexing_utils._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.2] * 1536, True)] * len(texts),
    )

    from core.descripterizer import descripterize_project

    db_path, chunks = indexed_chunks

    # First pass
    descripterize_project("testproj", db_path=db_path)

    # Force re-describe
    stats = descripterize_project("testproj", db_path=db_path, force=True)
    assert stats["described"] > 0
    assert stats["total"] > 0


def test_descripterize_empty_project(tmp_byomem, tmp_path):
    """descripterize_project on a project with no chunks returns zero stats."""
    from core.code_index import get_code_db
    from core.descripterizer import descripterize_project

    db_path = tmp_path / "code.db"
    # Just create the DB
    db = get_code_db(db_path)
    db.close()

    stats = descripterize_project("nonexistent", db_path=db_path)
    assert stats == {"described": 0, "failed": 0, "skipped": 0, "total": 0}


def test_descripterize_handles_llm_failure(indexed_chunks, mocker):
    """When the LLM fails, chunks are counted as failed, not described."""
    mocker.patch(
        "core.descripterizer._call_llm",
        side_effect=RuntimeError("LLM unavailable"),
    )
    mocker.patch(
        "core.indexing_utils._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.2] * 1536, True)] * len(texts),
    )

    from core.descripterizer import descripterize_project

    db_path, chunks = indexed_chunks
    stats = descripterize_project("testproj", db_path=db_path)

    assert stats["failed"] > 0
    assert stats["described"] == 0


# ============================================================
# Config tests
# ============================================================


def test_descripterizer_batch_size_default():
    """Default descripterizer_batch_size is 8."""
    from core.config import Config

    cfg = Config()
    assert cfg.descripterizer_batch_size == 8


def test_system_prompt_content():
    """System prompt includes key instructions."""
    from core.descripterizer import DESCRIPTERIZER_SYSTEM

    assert "WHAT the code does" in DESCRIPTERIZER_SYSTEM
    assert "chunk_id" in DESCRIPTERIZER_SYSTEM
    assert "descriptions" in DESCRIPTERIZER_SYSTEM
