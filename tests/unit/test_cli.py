"""Tests for cli.py — all CLI subcommands."""
import json

from cli import (
    cmd_install,
    cmd_log,
    cmd_merge,
    cmd_reindex,
    cmd_search,
    cmd_show,
    cmd_status,
    cmd_uninstall,
)
from core.config import get_config


def _count_byomem_hooks(stop_list):
    """Count byomem hook entries in nested Stop hook structure."""
    count = 0
    for entry in stop_list:
        for h in entry.get("hooks", []):
            if "stop_hook.py" in h.get("command", ""):
                count += 1
    return count


# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------


def test_install_creates_settings(tmp_settings):
    """Fresh install creates settings.json with hook + MCP entries."""
    cmd_install()
    data = json.loads(tmp_settings.read_text())
    # Stop hook present (nested structure)
    stop_hooks = data.get("hooks", {}).get("Stop", [])
    assert _count_byomem_hooks(stop_hooks) == 1
    # MCP server present
    assert "byomem" in data.get("mcpServers", {})


def test_install_preserves_existing(tmp_settings):
    """Existing settings keys are preserved after install."""
    tmp_settings.write_text(json.dumps({"myCustomKey": 42, "hooks": {}}))
    cmd_install()
    data = json.loads(tmp_settings.read_text())
    assert data["myCustomKey"] == 42


def test_install_idempotent(tmp_settings):
    """Running install twice doesn't duplicate entries."""
    cmd_install()
    cmd_install()
    data = json.loads(tmp_settings.read_text())
    stop_hooks = data.get("hooks", {}).get("Stop", [])
    assert _count_byomem_hooks(stop_hooks) == 1


def test_install_absolute_paths(tmp_settings):
    """No ~ shorthand in any written path."""
    cmd_install()
    raw = tmp_settings.read_text()
    assert "~" not in raw


def test_install_fails_missing_venv(tmp_settings, capsys):
    """Error message when venv python is missing."""
    cfg = get_config()
    venv_python = cfg.byomem / ".venv" / "bin" / "python"
    venv_python.unlink()
    cmd_install()
    captured = capsys.readouterr()
    assert "venv" in captured.err.lower() or "python" in captured.err.lower() \
        or "not found" in captured.err.lower()
    # settings.json should NOT be created on failure
    assert not tmp_settings.exists()


def test_install_creates_settings_dir(tmp_settings):
    """Creates parent directory for settings.json if needed."""
    cfg = get_config()
    nested = cfg.settings_path.parent / "subdir" / "settings.json"
    import core.config as config_mod
    from core.config import Config
    new_cfg = Config(byomem=cfg.byomem, settings_path=nested)
    old = config_mod._config
    config_mod._config = new_cfg
    try:
        cmd_install()
        assert nested.parent.is_dir()
    finally:
        config_mod._config = old


def test_install_handles_malformed_json(tmp_settings, capsys):
    """Backs up malformed settings.json and creates fresh settings."""
    tmp_settings.write_text("{bad json content!!!}")
    cmd_install()
    data = json.loads(tmp_settings.read_text())
    assert "hooks" in data or "mcpServers" in data
    backups = list(tmp_settings.parent.glob("*.bak"))
    assert len(backups) >= 1


# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------


def test_uninstall_removes_entries(tmp_settings):
    """Removes hook + MCP entries from settings."""
    cmd_install()
    cmd_uninstall()
    data = json.loads(tmp_settings.read_text())
    stop_hooks = data.get("hooks", {}).get("Stop", [])
    assert _count_byomem_hooks(stop_hooks) == 0
    assert "byomem" not in data.get("mcpServers", {})


def test_uninstall_preserves_other(tmp_settings):
    """Other settings are untouched after uninstall."""
    tmp_settings.write_text(json.dumps({
        "myKey": "myValue",
        "hooks": {"Stop": [
            {"matcher": "", "hooks": [{"type": "command", "command": "other-hook"}]},
        ]},
        "mcpServers": {"other": {"command": "other"}},
    }))
    cmd_install()
    cmd_uninstall()
    data = json.loads(tmp_settings.read_text())
    assert data["myKey"] == "myValue"
    assert "other" in data["mcpServers"]
    # Other hooks preserved
    assert len(data["hooks"]["Stop"]) == 1
    assert "other-hook" in data["hooks"]["Stop"][0]["hooks"][0]["command"]


def test_uninstall_noop_if_clean(tmp_settings):
    """No error when uninstalling from clean settings."""
    tmp_settings.write_text(json.dumps({}))
    cmd_uninstall()  # Should not raise


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_installed(tmp_settings, capsys):
    """Reports installed when entries are present."""
    cmd_install()
    cmd_status()
    captured = capsys.readouterr()
    assert "installed" in captured.out.lower()


def test_status_not_installed(tmp_settings, capsys):
    """Reports not installed when entries are missing."""
    tmp_settings.write_text(json.dumps({}))
    cmd_status()
    captured = capsys.readouterr()
    assert "not installed" in captured.out.lower()


# ---------------------------------------------------------------------------
# show
# ---------------------------------------------------------------------------


def test_show_lists_branches(tmp_settings, capsys):
    """Lists branches with metadata summaries."""
    cfg = get_config()
    project_dir = cfg.byomem / "myproject" / "branches" / "2026-02-19-abcdef12"
    project_dir.mkdir(parents=True)
    (project_dir / "metadata.md").write_text(
        "status: open\nlast_updated: 2026-02-19T10:00:00\n"
    )
    cmd_show("myproject")
    captured = capsys.readouterr()
    assert "2026-02-19-abcdef12" in captured.out


def test_show_missing_project(tmp_settings, capsys):
    """Handles missing project gracefully."""
    cmd_show("nonexistent")
    captured = capsys.readouterr()
    assert "no branches" in captured.out.lower() or "nonexistent" in captured.out.lower()


# ---------------------------------------------------------------------------
# log
# ---------------------------------------------------------------------------


def test_log_prints_commit(tmp_settings, capsys):
    """Prints commit.md content for a branch."""
    cfg = get_config()
    branch_dir = cfg.byomem / "myproject" / "branches" / "2026-02-19-abcdef12"
    branch_dir.mkdir(parents=True)
    (branch_dir / "commit.md").write_text("## This Commit's Contribution\n[FIX] Fixed stop price\n")
    cmd_log("myproject", "2026-02-19-abcdef12")
    captured = capsys.readouterr()
    assert "Fixed stop price" in captured.out


def test_log_missing_branch(tmp_settings, capsys):
    """Handles missing branch gracefully."""
    cmd_log("myproject", "2026-02-19-nonexist")
    captured = capsys.readouterr()
    assert "not found" in captured.out.lower()


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def test_search_calls_hybrid(tmp_settings, mocker, capsys):
    """Calls hybrid_search and formats output."""
    mock_search = mocker.patch("core.search_index.hybrid_search", return_value=[
        {"path": "proj/commit.md", "score": 0.85, "start_line": 1, "end_line": 5,
         "preview": "Fixed the bug"},
    ])
    cmd_search("stop price bug")
    mock_search.assert_called_once()
    captured = capsys.readouterr()
    assert "0.85" in captured.out or "Fixed the bug" in captured.out


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------


def test_merge_updates_main(tmp_settings):
    """Appends to main.md and sets metadata status to merged."""
    cfg = get_config()
    project_dir = cfg.byomem / "myproject"
    branch_dir = project_dir / "branches" / "2026-02-19-abcdef12"
    branch_dir.mkdir(parents=True)
    (branch_dir / "commit.md").write_text(
        "## This Commit's Contribution\n[FIX] Fixed stop price\n"
    )
    (branch_dir / "metadata.md").write_text("status: open\nlast_updated: 2026-02-19\n")
    cmd_merge("myproject", "2026-02-19-abcdef12")
    main_md = project_dir / "main.md"
    assert main_md.exists()
    assert "abcdef12" in main_md.read_text()
    meta = (branch_dir / "metadata.md").read_text()
    assert "merged" in meta.lower()


def test_merge_idempotent(tmp_settings, capsys):
    """Second merge is a no-op with message."""
    cfg = get_config()
    branch_dir = cfg.byomem / "myproject" / "branches" / "2026-02-19-abcdef12"
    branch_dir.mkdir(parents=True)
    (branch_dir / "commit.md").write_text("[FIX] Fixed stop price\n")
    (branch_dir / "metadata.md").write_text("status: merged\nlast_updated: 2026-02-19\n")
    (cfg.byomem / "myproject" / "main.md").write_text("existing\n")
    cmd_merge("myproject", "2026-02-19-abcdef12")
    captured = capsys.readouterr()
    assert "already" in captured.out.lower() or "merged" in captured.out.lower()


def test_merge_missing_branch(tmp_settings, capsys):
    """Handles missing branch gracefully."""
    cmd_merge("myproject", "2026-02-19-nonexist")
    captured = capsys.readouterr()
    assert "not found" in captured.out.lower()


# ---------------------------------------------------------------------------
# reindex
# ---------------------------------------------------------------------------


def test_reindex_rebuilds(tmp_settings, mock_openai_embed):
    """Deletes and rebuilds search DB."""
    cfg = get_config()
    # Create a file to index
    proj = cfg.byomem / "myproject"
    proj.mkdir(parents=True)
    (proj / "main.md").write_text("# myproject\nSome content\n")
    # Create existing DB
    cfg.db_path.touch()
    cmd_reindex()
    # DB should exist (rebuilt)
    assert cfg.db_path.exists()


def test_reindex_empty(tmp_settings, mock_openai_embed, capsys):
    """No-op on empty memory."""
    cmd_reindex()
    captured = capsys.readouterr()
    assert "0 file" in captured.out.lower()
