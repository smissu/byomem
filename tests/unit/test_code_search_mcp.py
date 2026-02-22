"""Tests for code_search MCP tool — must FAIL until code_search is implemented.

AC-1: code_search is registered and callable with the right signature.
AC-2: Returns results with score, path, start_line, end_line, preview fields.
AC-3: project parameter filters results to correct namespace.
AC-4: Empty code.db (or no results) returns empty list without error.
AC-5: Calling code_search does NOT open or query search.db (memory DB isolation).
AC-6: Results are ordered by score descending; ties broken by path ascending.
"""


# ---------- AC-1: tool is importable and callable ----------


def test_code_search_importable():
    """code_search can be imported from mcp_server."""
    from mcp_server import code_search  # noqa: F401


def test_code_search_callable_with_query_and_project(mocker):
    """code_search accepts query and project parameters."""
    mocker.patch("core.code_index.code_search", return_value=[])
    from mcp_server import code_search

    result = code_search(query="foo", project="byomem")
    assert result is not None


# ---------- AC-2: result schema ----------


def test_code_search_result_contains_expected_fields(mocker):
    """Results include score, path, start_line, end_line, preview."""
    mocker.patch(
        "core.code_index.code_search",
        return_value=[
            {
                "score": 0.85,
                "path": "byomem/core/foo.py",
                "start_line": 5,
                "end_line": 15,
                "preview": "class Foo:",
            }
        ],
    )
    from mcp_server import code_search

    result = code_search(query="Foo class", project="byomem")
    assert "byomem/core/foo.py" in result
    assert "0.85" in result
    assert "class Foo:" in result


def test_code_search_result_contains_line_numbers(mocker):
    """Result output includes start and end line numbers."""
    mocker.patch(
        "core.code_index.code_search",
        return_value=[
            {
                "score": 0.90,
                "path": "byomem/core/bar.py",
                "start_line": 10,
                "end_line": 25,
                "preview": "def bar():",
            }
        ],
    )
    from mcp_server import code_search

    result = code_search(query="bar function", project="byomem")
    assert "10" in result
    assert "25" in result


# ---------- AC-3: project filtering ----------


def test_code_search_passes_project_to_code_index(mocker):
    """project parameter is forwarded to core.code_index.code_search."""
    mock_search = mocker.patch("core.code_index.code_search", return_value=[])
    from mcp_server import code_search

    code_search(query="test", project="my-project")
    call_kwargs = mock_search.call_args
    # project must be passed through (positional or keyword)
    assert "my-project" in str(call_kwargs)


# ---------- AC-4: empty results ----------


def test_code_search_empty_returns_gracefully(mocker):
    """Empty result set returns without error."""
    mocker.patch("core.code_index.code_search", return_value=[])
    from mcp_server import code_search

    result = code_search(query="nonexistent", project="byomem")
    assert result is not None
    assert isinstance(result, str)


def test_code_search_empty_result_message(mocker):
    """Empty results produce a '0 results' style message."""
    mocker.patch("core.code_index.code_search", return_value=[])
    from mcp_server import code_search

    result = code_search(query="nothing-here", project="byomem")
    assert "0" in result or "no" in result.lower()


# ---------- AC-5: memory DB isolation ----------


def test_code_search_does_not_touch_search_db(mocker):
    """code_search must not call hybrid_search (memory search.db)."""
    mocker.patch("core.code_index.code_search", return_value=[])
    mock_mem = mocker.patch("core.search_index.hybrid_search")
    from mcp_server import code_search

    code_search(query="test", project="byomem")
    mock_mem.assert_not_called()


def test_code_search_does_not_import_search_index_hybrid(mocker):
    """code_search invocation path should go through code_index, not search_index."""
    mock_code = mocker.patch(
        "core.code_index.code_search",
        return_value=[
            {
                "score": 0.75,
                "path": "byomem/core/x.py",
                "start_line": 1,
                "end_line": 5,
                "preview": "x = 1",
            }
        ],
    )
    mock_mem = mocker.patch("core.search_index.hybrid_search")
    from mcp_server import code_search

    code_search(query="x variable", project="byomem")
    mock_code.assert_called_once()
    mock_mem.assert_not_called()


# ---------- AC-6: result ordering ----------


def test_code_search_result_ordering_by_score_desc(mocker):
    """Higher score results appear before lower score results in output."""
    mocker.patch(
        "core.code_index.code_search",
        return_value=[
            {"score": 0.7, "path": "byomem/b.py", "start_line": 1, "end_line": 5, "preview": "b"},
            {"score": 0.9, "path": "byomem/a.py", "start_line": 1, "end_line": 5, "preview": "a"},
        ],
    )
    from mcp_server import code_search

    result = code_search(query="test", project="byomem")
    # Higher score (a.py at 0.9) should appear before lower (b.py at 0.7)
    assert result.index("byomem/a.py") < result.index("byomem/b.py")


def test_code_search_result_ordering_tie_by_path_asc(mocker):
    """When scores are tied, results are ordered by path ascending."""
    mocker.patch(
        "core.code_index.code_search",
        return_value=[
            {"score": 0.8, "path": "byomem/z.py", "start_line": 1, "end_line": 5, "preview": "z"},
            {"score": 0.8, "path": "byomem/a.py", "start_line": 1, "end_line": 5, "preview": "a"},
        ],
    )
    from mcp_server import code_search

    result = code_search(query="test", project="byomem")
    # Same score — a.py (alphabetically first) should appear before z.py
    assert result.index("byomem/a.py") < result.index("byomem/z.py")
