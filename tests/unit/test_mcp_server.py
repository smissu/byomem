"""Tests for mcp_server.py — FastMCP tool implementations."""

from mcp_server import (
    mem_context,
    mem_get,
    mem_health_check,
    mem_latest,
    mem_list_projects,
    mem_search,
    mem_show,
    mem_stats,
)

# ---------- mem_context ----------


def test_mem_context_bare(tmp_byomem):
    """Bare call (no branch) returns main.md content + branch listing."""
    proj = tmp_byomem / "myproject"
    proj.mkdir()
    (proj / "main.md").write_text("# myproject\n\n## Key Decisions & Fixes\n- [FIX] thing\n")
    branches = proj / "branches"
    branches.mkdir()
    b = branches / "2026-02-19-abc12345"
    b.mkdir()
    (b / "metadata.md").write_text("summary: Fixed stop price\n")
    (b / "commit.md").write_text("")
    (b / "log.md").write_text("")

    result = mem_context(project="myproject")
    assert "myproject" in result
    assert "[FIX] thing" in result
    assert "2026-02-19-abc12345" in result
    assert "Fixed stop price" in result


def test_mem_context_with_branch(tmp_byomem):
    """With branch, returns metadata + recent commits."""
    proj = tmp_byomem / "myproject" / "branches" / "2026-02-19-abc12345"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("# 2026-02-19-abc12345\nstatus: active\n")
    (proj / "commit.md").write_text("## This Commit's Contribution\nFixed stop price.\n")
    (proj / "log.md").write_text("")

    result = mem_context(project="myproject", branch="2026-02-19-abc12345")
    assert "active" in result
    assert "Fixed stop price" in result


def test_mem_context_with_commit(tmp_byomem):
    """With branch + commit, returns full commit.md."""
    proj = tmp_byomem / "myproject" / "branches" / "2026-02-19-abc12345"
    proj.mkdir(parents=True)
    commit_text = "## This Commit's Contribution\nFull detail here.\n\n## Previous\nOlder stuff.\n"
    (proj / "commit.md").write_text(commit_text)
    (proj / "metadata.md").write_text("")
    (proj / "log.md").write_text("")

    result = mem_context(project="myproject", branch="2026-02-19-abc12345", commit="all")
    assert "Full detail here" in result
    assert "Older stuff" in result


def test_mem_context_with_log_lines(tmp_byomem):
    """With branch + log_lines, returns last N lines of log.md."""
    proj = tmp_byomem / "myproject" / "branches" / "2026-02-19-abc12345"
    proj.mkdir(parents=True)
    log_lines = "\n".join(f"line {i}" for i in range(20))
    (proj / "log.md").write_text(log_lines)
    (proj / "commit.md").write_text("")
    (proj / "metadata.md").write_text("")

    result = mem_context(project="myproject", branch="2026-02-19-abc12345", log_lines=5)
    assert "line 19" in result
    assert "line 15" in result


def test_mem_context_missing_project(tmp_byomem):
    """Missing project returns informative message."""
    result = mem_context(project="nonexistent")
    assert "not found" in result.lower() or "no" in result.lower()


# ---------- mem_search ----------


def test_mem_search_returns_results(tmp_byomem, mock_openai_embed):
    """mem_search returns formatted search results."""
    proj = tmp_byomem / "proj"
    proj.mkdir()
    f = proj / "main.md"
    f.write_text("stop price uses aux_price field")
    from core.search_index import index_file

    index_file(f, project="proj")

    result = mem_search(query="stop price", project="proj", min_score=0.0)
    assert "stop price" in result.lower() or "aux_price" in result


def test_mem_search_empty_results(tmp_byomem, mock_openai_embed):
    """mem_search with no matches returns empty message."""
    result = mem_search(query="nonexistent", min_score=0.0)
    assert "0 results" in result or "no results" in result.lower()


def test_mem_search_enrich_mode_appends_log(tmp_byomem, mock_openai_embed, monkeypatch):
    """Enrich mode: search result from commit.md with turn anchor gets raw log context appended."""
    from core.config import Config

    test_config = Config(byomem=tmp_byomem, log_search_mode="enrich")
    monkeypatch.setattr("core.config._config", test_config)

    # Create branch with commit.md containing a turn anchor and log.md with matching turn
    branch_dir = tmp_byomem / "proj" / "branches" / "2026-02-20-abc12345"
    branch_dir.mkdir(parents=True)
    (branch_dir / "commit.md").write_text(
        "## This Commit's Contribution\n"
        "**[FIX] Fix stop price** <!-- turn: uuid-abc-123 -->\n"
        "Use aux_price not stop_price.\n"
    )
    (branch_dir / "log.md").write_text(
        "<!-- last_id: uuid-abc-123 -->\n"
        "---\n**[2026-02-20]** why is stop price wrong?\n\n"
        "The field is aux_price not stop_price.\n"
        "<!-- last_id: uuid-def-456 -->\n"
        "---\n**[2026-02-20]** another question\n"
    )
    (branch_dir / "metadata.md").write_text("status: active\n")

    from core.search_index import index_file

    index_file(branch_dir / "commit.md", project="proj")

    result = mem_search(query="stop price", project="proj", min_score=0.0)
    assert "> Raw log:" in result
    assert "aux_price" in result


# ---------- mem_get ----------


def test_mem_get_reads_lines(tmp_byomem):
    """mem_get reads specific line range from a file."""
    proj = tmp_byomem / "myproject"
    proj.mkdir()
    content = "\n".join(f"line {i}" for i in range(1, 21))
    (proj / "main.md").write_text(content)

    result = mem_get(path="myproject/main.md", start_line=5, line_count=3)
    assert "line 5" in result
    assert "line 7" in result


def test_mem_get_missing_file(tmp_byomem):
    """mem_get on missing file returns error message."""
    result = mem_get(path="nonexistent/file.md", start_line=1, line_count=10)
    assert "not found" in result.lower() or "error" in result.lower()


# ---------- mem_show ----------


def test_mem_show_lists_branches(tmp_byomem):
    """mem_show returns branch listing with summaries."""
    proj = tmp_byomem / "myproject" / "branches"
    proj.mkdir(parents=True)
    b1 = proj / "2026-02-19-abc12345"
    b1.mkdir()
    (b1 / "metadata.md").write_text("summary: Fixed stop price\n")
    b2 = proj / "2026-02-18-def67890"
    b2.mkdir()
    (b2 / "metadata.md").write_text("summary: IC combo orders\n")

    result = mem_show(project="myproject")
    assert "2026-02-19-abc12345" in result
    assert "2026-02-18-def67890" in result
    assert "Fixed stop price" in result
    assert "IC combo orders" in result


def test_mem_show_missing_project(tmp_byomem):
    """mem_show on missing project returns informative message."""
    result = mem_show(project="ghost")
    assert "no branches" in result.lower() or "not found" in result.lower()


# ---------- mem_latest ----------


def test_mem_latest_returns_most_recent(tmp_byomem):
    """mem_latest returns the most recent branch's commit.md."""
    proj = tmp_byomem / "myproject" / "branches"
    proj.mkdir(parents=True)
    b1 = proj / "2026-02-18-old11111"
    b1.mkdir()
    (b1 / "commit.md").write_text("Old commit content\n")
    b2 = proj / "2026-02-19-new22222"
    b2.mkdir()
    (b2 / "commit.md").write_text("## This Commit's Contribution\nLatest work.\n")

    result = mem_latest(project="myproject")
    assert "2026-02-19-new22222" in result
    assert "Latest work" in result


def test_mem_latest_no_branches(tmp_byomem):
    """mem_latest with no branches returns informative message."""
    result = mem_latest(project="empty")
    assert "no branches" in result.lower() or "not found" in result.lower()


# ---------- mem_list_projects ----------


def test_mem_list_projects(tmp_byomem):
    """mem_list_projects returns all project directories."""
    (tmp_byomem / "alpha").mkdir()
    (tmp_byomem / "alpha" / "main.md").write_text("# alpha\n")
    (tmp_byomem / "beta").mkdir()
    (tmp_byomem / "beta" / "branches").mkdir()

    result = mem_list_projects()
    assert "alpha" in result
    assert "beta" in result


def test_mem_list_projects_empty(tmp_byomem):
    """mem_list_projects with no projects returns empty message."""
    result = mem_list_projects()
    assert "no projects" in result.lower() or result.strip() != ""


# ---------- mem_stats ----------


def test_mem_stats_with_project(tmp_byomem):
    """mem_stats returns project statistics."""
    proj = tmp_byomem / "myproject" / "branches"
    proj.mkdir(parents=True)
    b = proj / "2026-02-19-abc12345"
    b.mkdir()
    (b / "metadata.md").write_text("status: active\ntype: fix\n")
    (b / "commit.md").write_text("content")

    result = mem_stats(project="myproject")
    assert "myproject" in result
    assert "1" in result  # branch count


def test_mem_stats_global(tmp_byomem):
    """mem_stats without project returns global stats."""
    proj = tmp_byomem / "proj" / "branches"
    proj.mkdir(parents=True)
    b = proj / "2026-02-19-abc"
    b.mkdir()
    (b / "metadata.md").write_text("status: active\n")

    result = mem_stats()
    assert "Global" in result or "project" in result.lower()


# ---------- mem_health_check ----------


def test_mem_health_check_clean(tmp_byomem):
    """mem_health_check reports healthy on clean state."""
    result = mem_health_check()
    assert "healthy" in result.lower()


def test_mem_health_check_issues(tmp_byomem, mock_openai_embed):
    """mem_health_check reports orphaned entries."""
    proj = tmp_byomem / "proj"
    proj.mkdir(parents=True)
    f = proj / "doc.md"
    f.write_text("orphan me")
    from core.search_index import index_file

    index_file(f, project="proj")
    f.unlink()

    result = mem_health_check()
    assert "issues_found" in result.lower() or "1" in result
