"""Tests for core.memory_writer — main.md and project MEMORY.md updates."""
from datetime import date

from core.memory_writer import (
    _cc_memory_path,
    maybe_update_main,
    maybe_update_project_memory,
)


def test_update_main_creates_file(tmp_byomem, sample_summary):
    maybe_update_main("myproject", sample_summary)
    main = tmp_byomem / "myproject" / "main.md"
    assert main.exists()


def test_update_main_appends(tmp_byomem, sample_summary):
    maybe_update_main("myproject", sample_summary)
    summary2 = {**sample_summary, "title": "Add retry logic"}
    maybe_update_main("myproject", summary2)
    content = (tmp_byomem / "myproject" / "main.md").read_text()
    assert "Fix stop price" in content
    assert "Add retry logic" in content


def test_update_main_entry_format(tmp_byomem, sample_summary):
    maybe_update_main("myproject", sample_summary)
    content = (tmp_byomem / "myproject" / "main.md").read_text()
    today = date.today().isoformat()
    expected = f"- [{today}] [FIX] {sample_summary['title']}: {sample_summary['summary']}"
    assert expected in content


def test_update_main_adds_section_if_missing(tmp_byomem, sample_summary):
    main = tmp_byomem / "myproject" / "main.md"
    main.parent.mkdir(parents=True, exist_ok=True)
    main.write_text("# myproject\n")
    maybe_update_main("myproject", sample_summary)
    content = main.read_text()
    assert "## Key Decisions & Fixes" in content


def test_update_project_memory_creates_file(tmp_byomem, sample_summary, tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    maybe_update_project_memory("/Users/x/myproject", sample_summary)
    path = tmp_path / ".claude" / "projects" / "-Users-x-myproject" / "memory" / "MEMORY.md"
    assert path.exists()


def test_update_project_memory_appends(tmp_byomem, sample_summary, tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    maybe_update_project_memory("/Users/x/myproject", sample_summary)
    summary2 = {**sample_summary, "title": "Add retry logic"}
    maybe_update_project_memory("/Users/x/myproject", summary2)
    path = tmp_path / ".claude" / "projects" / "-Users-x-myproject" / "memory" / "MEMORY.md"
    content = path.read_text()
    assert "Fix stop price" in content
    assert "Add retry logic" in content


def test_cc_memory_path_encoding(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    result = _cc_memory_path("/Users/x/y")
    assert "-Users-x-y" in str(result)
    assert result.name == "MEMORY.md"


def test_cc_memory_path_creates_parent(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    result = _cc_memory_path("/Users/x/y")
    assert result.parent.is_dir()


def test_cc_memory_path_trailing_slash(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    result = _cc_memory_path("/Users/x/y/")
    # Trailing slash should not create double dash or break encoding
    assert "MEMORY.md" in str(result)
    assert result.parent.is_dir()


def test_cc_memory_path_spaces(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    result = _cc_memory_path("/Users/my user/my project")
    assert "-Users-my user-my project" in str(result)
    assert result.parent.is_dir()
