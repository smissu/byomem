"""Tests for cli.py — all CLI subcommands."""
import json

from cli import (
    cmd_gc,
    cmd_health,
    cmd_install,
    cmd_log,
    cmd_merge,
    cmd_queue,
    cmd_reindex,
    cmd_search,
    cmd_show,
    cmd_stats,
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


# ---------------------------------------------------------------------------
# gc
# ---------------------------------------------------------------------------


def test_gc_dry_run(tmp_settings, capsys):
    """--dry-run shows what would be deleted without deleting."""
    cfg = get_config()
    proj = cfg.byomem / "myproject" / "branches" / "2020-01-01-abc12345"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: merged\n")
    (proj / "commit.md").write_text("content")

    cmd_gc(project="myproject", days=0, dry_run=True)
    captured = capsys.readouterr()
    assert "dry-run" in captured.out.lower()
    assert "2020-01-01-abc12345" in captured.out
    # Directory still exists
    assert proj.exists()


def test_gc_deletes_merged(tmp_settings, capsys):
    """Deletes merged branches older than --days."""
    cfg = get_config()
    proj = cfg.byomem / "myproject" / "branches" / "2020-01-01-abc12345"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: merged\n")
    (proj / "commit.md").write_text("content")

    cmd_gc(project="myproject", days=0)
    assert not proj.exists()
    captured = capsys.readouterr()
    assert "deleted" in captured.out.lower() or "1 branch" in captured.out.lower()


def test_gc_preserves_active(tmp_settings, capsys):
    """Active branches are not deleted."""
    cfg = get_config()
    proj = cfg.byomem / "myproject" / "branches" / "2020-01-01-abc12345"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: active\n")
    (proj / "commit.md").write_text("content")

    cmd_gc(project="myproject", days=0)
    assert proj.exists()


def test_gc_respects_project_filter(tmp_settings, capsys):
    """--project limits GC to one project."""
    cfg = get_config()
    for p in ["projA", "projB"]:
        d = cfg.byomem / p / "branches" / "2020-01-01-abc12345"
        d.mkdir(parents=True)
        (d / "metadata.md").write_text("status: merged\n")
        (d / "commit.md").write_text("content")

    cmd_gc(project="projA", days=0)
    assert not (cfg.byomem / "projA" / "branches" / "2020-01-01-abc12345").exists()
    assert (cfg.byomem / "projB" / "branches" / "2020-01-01-abc12345").exists()


def test_gc_nothing_to_clean(tmp_settings, capsys):
    """No matching branches produces clean message."""
    cmd_gc(project="nonexistent", days=0)
    captured = capsys.readouterr()
    assert "nothing" in captured.out.lower()


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------


def test_stats_with_project(tmp_settings, capsys):
    """Shows stats for a specific project."""
    cfg = get_config()
    proj = cfg.byomem / "myproject" / "branches" / "2026-02-19-abc12345"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: active\ntype: fix\n")
    (proj / "commit.md").write_text("content")

    cmd_stats(project="myproject")
    captured = capsys.readouterr()
    assert "myproject" in captured.out
    assert "1" in captured.out  # branch count


def test_stats_global(tmp_settings, capsys):
    """Shows global stats."""
    cfg = get_config()
    proj = cfg.byomem / "proj" / "branches" / "2026-02-19-abc"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: active\n")

    cmd_stats()
    captured = capsys.readouterr()
    assert "project" in captured.out.lower()


def test_stats_json_format(tmp_settings, capsys):
    """--format json outputs valid JSON."""
    import json
    cfg = get_config()
    proj = cfg.byomem / "myproject" / "branches" / "2026-02-19-abc"
    proj.mkdir(parents=True)
    (proj / "metadata.md").write_text("status: active\n")

    cmd_stats(project="myproject", fmt="json")
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert data["project"] == "myproject"


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------


def test_health_clean(tmp_settings, capsys):
    """Health check on clean state reports healthy."""
    cmd_health()
    captured = capsys.readouterr()
    assert "healthy" in captured.out.lower()


def test_health_detects_issues(tmp_settings, capsys, mock_openai_embed):
    """Health check detects orphaned entries."""
    cfg = get_config()
    proj = cfg.byomem / "proj"
    proj.mkdir(parents=True)
    f = proj / "doc.md"
    f.write_text("orphan me")
    from core.search_index import index_file
    index_file(f, project="proj")
    f.unlink()

    cmd_health()
    captured = capsys.readouterr()
    assert "issues_found" in captured.out.lower() or "1" in captured.out


# ---------------------------------------------------------------------------
# queue history
# ---------------------------------------------------------------------------


def _write_history(cfg, entries):
    """Write history.jsonl with the given list of dicts."""
    history_path = cfg.queue_path / "history.jsonl"
    history_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.write_text(
        "\n".join(json.dumps(e) for e in entries) + "\n"
    )


def test_queue_shows_history(tmp_settings, capsys):
    """Queue command displays recent history entries."""
    cfg = get_config()
    _write_history(cfg, [
        {"ts": "2026-02-19T18:30:00", "session": "72a0d04b", "model": "primary", "duration_s": 1.23, "status": "ok"},
        {"ts": "2026-02-19T18:31:00", "session": "abcd1234", "model": "qwen2.5:3b", "duration_s": 0.87, "status": "ok"},
    ])
    cmd_queue()
    captured = capsys.readouterr()
    assert "72a0d04b" in captured.out
    assert "abcd1234" in captured.out
    assert "primary" in captured.out
    assert "1.23" in captured.out


def test_queue_history_limit(tmp_settings, capsys):
    """--history N limits to last N entries."""
    cfg = get_config()
    entries = [
        {"ts": f"2026-02-19T18:{i:02d}:00", "session": f"sess{i:04d}", "model": "primary", "duration_s": 0.5, "status": "ok"}
        for i in range(20)
    ]
    _write_history(cfg, entries)
    cmd_queue(history=3)
    captured = capsys.readouterr()
    assert "sess0017" in captured.out
    assert "sess0018" in captured.out
    assert "sess0019" in captured.out
    assert "sess0000" not in captured.out


def test_queue_no_history_file(tmp_settings, capsys):
    """No crash when history.jsonl doesn't exist."""
    cmd_queue()
    captured = capsys.readouterr()
    assert "Worker:" in captured.out


def test_queue_history_error_entries(tmp_settings, capsys):
    """Error-status entries display correctly."""
    cfg = get_config()
    _write_history(cfg, [
        {"ts": "2026-02-19T18:30:00", "session": "fail0001", "model": "primary", "duration_s": 0.10, "status": "error"},
    ])
    cmd_queue()
    captured = capsys.readouterr()
    assert "error" in captured.out
    assert "fail0001" in captured.out
