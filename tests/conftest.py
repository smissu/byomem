import pytest


@pytest.fixture
def tmp_byomem(tmp_path, monkeypatch):
    """Redirect ~/.byomem to a temp dir for all tests.

    Patches core.config._config so all modules that call get_config()
    see the temp root. This is the ONLY patch needed.
    """
    root = tmp_path / ".byomem"
    root.mkdir()
    from core.config import Config
    test_config = Config(byomem=root)
    monkeypatch.setattr("core.config._config", test_config)
    return root


@pytest.fixture
def sample_turn():
    return {
        "id": "uuid-abc-123",
        "timestamp": "2026-02-19T10:23:11",
        "user": "why is the stop price not updating?",
        "assistant": "Looking at the modify-order endpoint... the field is aux_price not stop_price.",
    }


@pytest.fixture
def sample_summary():
    return {
        "title": "Fix stop price field to use aux_price",
        "summary": "The modify-order endpoint requires aux_price, not stop_price.",
        "classification": "fix",
        "important": True,
        "milestone": True,
    }


@pytest.fixture
def mock_openai_embed(mocker):
    """Patch openai.OpenAI to return a fixed 1536-dim zero embedding."""
    mock = mocker.patch("core.search_index.openai.OpenAI")
    mock.return_value.embeddings.create.return_value.data = [
        mocker.Mock(embedding=[0.0] * 1536)
    ]
    return mock


@pytest.fixture
def mock_anthropic(mocker):
    """Patch anthropic.Anthropic to return a fixed summarizer response."""
    import json
    response_json = json.dumps({
        "title": "Test",
        "summary": "Test summary.",
        "classification": "fix",
        "important": True,
        "milestone": True,
    })
    mock = mocker.patch("core.summarizer.anthropic.Anthropic")
    mock.return_value.messages.create.return_value.content = [
        mocker.Mock(text=response_json)
    ]
    return mock


@pytest.fixture
def tmp_settings(tmp_path, monkeypatch):
    """Redirect settings.json to temp dir and create fake venv."""
    settings = tmp_path / "settings.json"
    root = tmp_path / ".byomem"
    root.mkdir(exist_ok=True)
    # Create fake venv python
    venv_python = root / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True, exist_ok=True)
    venv_python.touch()
    venv_python.chmod(0o755)
    # Create fake hook and mcp_server
    hooks_dir = root / "hooks"
    hooks_dir.mkdir(exist_ok=True)
    (hooks_dir / "stop_hook.py").touch()
    (root / "mcp_server.py").touch()
    from core.config import Config
    test_config = Config(byomem=root, settings_path=settings)
    monkeypatch.setattr("core.config._config", test_config)
    return settings
