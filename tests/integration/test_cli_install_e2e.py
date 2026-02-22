"""End-to-end integration tests for CLI install/uninstall."""

import json

from cli import cmd_install
from core.config import get_config


def test_fresh_install_json_structure(tmp_settings):
    """Verify exact JSON structure with absolute paths."""
    cmd_install()
    data = json.loads(tmp_settings.read_text())
    cfg = get_config()
    venv_python = str(cfg.byomem / ".venv" / "bin" / "python")
    stop_hook = str(cfg.byomem / "hooks" / "stop_hook.py")
    mcp_server = str(cfg.byomem / "mcp_server.py")

    # Verify hooks.Stop structure (nested: each entry has matcher + hooks array)
    assert "hooks" in data
    assert "Stop" in data["hooks"]
    stop_list = data["hooks"]["Stop"]
    assert isinstance(stop_list, list)
    assert len(stop_list) == 1

    entry = stop_list[0]
    assert entry["matcher"] == ""
    assert len(entry["hooks"]) == 1
    inner = entry["hooks"][0]
    assert inner["type"] == "command"
    assert venv_python in inner["command"]
    assert stop_hook in inner["command"]

    # Verify mcpServers.byomem structure
    assert "mcpServers" in data
    assert "byomem" in data["mcpServers"]
    mcp_entry = data["mcpServers"]["byomem"]
    assert mcp_entry["command"] == venv_python
    assert mcp_server in mcp_entry["args"]

    # All paths are absolute (no ~)
    raw = tmp_settings.read_text()
    assert "~" not in raw
    assert venv_python.startswith("/")


def test_idempotent_install_no_duplicates(tmp_settings):
    """Install twice, verify no duplicate hook or MCP entries."""
    cmd_install()
    cmd_install()
    data = json.loads(tmp_settings.read_text())

    stop_list = data.get("hooks", {}).get("Stop", [])
    # Count entries that contain byomem stop_hook
    byomem_count = sum(
        1
        for entry in stop_list
        for h in entry.get("hooks", [])
        if "stop_hook.py" in h.get("command", "")
    )
    assert byomem_count == 1


def test_preserves_existing_settings(tmp_settings):
    """Pre-existing keys survive install."""
    existing = {
        "theme": "dark",
        "hooks": {
            "Stop": [
                {"matcher": "", "hooks": [{"type": "command", "command": "my-other-hook"}]},
            ],
            "PreCommit": [{"type": "command", "command": "lint"}],
        },
        "mcpServers": {
            "other-server": {"command": "other", "args": []},
        },
    }
    tmp_settings.write_text(json.dumps(existing))
    cmd_install()
    data = json.loads(tmp_settings.read_text())

    # Existing keys preserved
    assert data["theme"] == "dark"
    assert "PreCommit" in data["hooks"]
    assert len(data["hooks"]["PreCommit"]) == 1
    assert "other-server" in data["mcpServers"]

    # Existing Stop hooks preserved alongside byomem
    stop_list = data["hooks"]["Stop"]
    # Should have 2 entries: original + byomem
    assert len(stop_list) == 2
