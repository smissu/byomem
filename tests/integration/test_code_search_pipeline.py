"""Integration tests: end-to-end code indexing and search pipeline."""

import pytest

AUTH_PY = """
class AuthService:
    def validate_token(self, token: str) -> bool:
        return token.startswith("Bearer ")

    def refresh_token(self, token: str) -> str:
        return token + "_refreshed"
"""


@pytest.fixture
def auth_src(tmp_path):
    """Write a Python source file to tmp_path and return the directory."""
    src = tmp_path / "myproject"
    src.mkdir()
    (src / "auth.py").write_text(AUTH_PY)
    return src


def test_index_and_search_python_file(auth_src, mock_openai_embed):
    """Indexing a Python file makes it searchable via code_search."""
    from core.code_index import code_search, index_source_file

    db_path = auth_src.parent / "code.db"

    index_source_file(auth_src / "auth.py", "myproject", db_path)

    # min_score=0.0 because mock embeddings are all zeros (no vector score contribution)
    results = code_search("validate_token", project="myproject", db_path=db_path, min_score=0.0)
    assert len(results) > 0
    assert any("validate_token" in r["preview"] for r in results)

    # Results have expected schema
    for r in results:
        assert "score" in r
        assert "path" in r
        assert "start_line" in r
        assert "end_line" in r
        assert "preview" in r


def test_code_db_isolated_from_memory_db(tmp_byomem, tmp_path, auth_src, mock_openai_embed):
    """code.db and search.db are separate files; indexing code does not pollute mem search."""
    from core.code_index import code_search, index_source_file
    from core.config import get_config

    cfg = get_config()

    # The two DB paths must differ
    db_path = tmp_path / "code.db"
    assert cfg.code_db_path != cfg.db_path

    index_source_file(auth_src / "auth.py", "myproject", db_path)

    # code_search finds results in code.db (min_score=0.0: mock embeddings yield no vector score)
    results = code_search("AuthService", project="myproject", db_path=db_path, min_score=0.0)
    assert len(results) > 0

    # hybrid_search on search.db returns nothing for this content
    from core.search_index import hybrid_search

    mem_results = hybrid_search("AuthService", project="myproject")
    assert mem_results == []


def test_python_chunks_include_class_header(auth_src, mock_openai_embed):
    """Method chunks produced by the Python-aware chunker include the enclosing class header."""
    from core.code_index import code_search, index_source_file

    db_path = auth_src.parent / "code.db"

    index_source_file(auth_src / "auth.py", "myproject", db_path)

    # min_score=0.0: mock embeddings are all zeros so keyword-only score is ~0.21
    results = code_search("refresh_token", project="myproject", db_path=db_path, min_score=0.0)

    # The method chunk should include the class header as context
    assert any("AuthService" in r["preview"] and "refresh_token" in r["preview"] for r in results)
