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
def tmp_byomem_ollama(tmp_path, monkeypatch):
    """Redirect ~/.byomem to temp dir with Ollama-style config."""
    root = tmp_path / ".byomem"
    root.mkdir()
    from core.config import Config
    test_config = Config(
        byomem=root,
        summarizer_model="qwen3:8b",
        summarizer_fallback_model="qwen3:8b",
        summarizer_base_url="http://localhost:11434/v1",
    )
    monkeypatch.setattr("core.config._config", test_config)
    return root


@pytest.fixture
def tmp_byomem_gemini(tmp_path, monkeypatch):
    """Redirect ~/.byomem to temp dir with Gemini CLI + Ollama config."""
    root = tmp_path / ".byomem"
    root.mkdir()
    from core.config import Config
    test_config = Config(
        byomem=root,
        summarizer_gemini_cli="gemini",
        summarizer_model="qwen3:8b",
        summarizer_fallback_model="qwen3:8b",
        summarizer_base_url="http://localhost:11434/v1",
    )
    monkeypatch.setattr("core.config._config", test_config)
    return root


@pytest.fixture
def mock_gemini_single(mocker):
    """Patch subprocess.run to simulate successful Gemini CLI single-turn response."""
    import json
    response_json = json.dumps({
        "title": "Fix stop price field",
        "summary": "Use aux_price not stop_price.",
        "classification": "fix",
        "important": True,
        "milestone": True,
    })
    wrapper = json.dumps({
        "session_id": "test-session",
        "response": response_json,
        "stats": {},
    })
    mock_result = mocker.Mock()
    mock_result.returncode = 0
    mock_result.stdout = wrapper
    mock_result.stderr = ""
    # Also mock shutil.which to return the binary path
    mocker.patch("core.summarizer.shutil.which", return_value="/usr/bin/gemini")
    mock = mocker.patch("core.summarizer.subprocess.run", return_value=mock_result)
    return mock


@pytest.fixture
def mock_gemini_batch(mocker):
    """Patch subprocess.run to simulate successful Gemini CLI batch response."""
    import json
    response_json = json.dumps({
        "summaries": [
            {"turn_id": "u1", "title": "Fix stop price field",
             "summary": "Use aux_price.", "classification": "fix",
             "important": True, "milestone": True},
            {"turn_id": "u2", "title": "Set trailing stop type",
             "summary": "Use trailing_stop_type=1.", "classification": "feature",
             "important": False, "milestone": False},
        ]
    })
    wrapper = json.dumps({
        "session_id": "test-session",
        "response": response_json,
        "stats": {},
    })
    mock_result = mocker.Mock()
    mock_result.returncode = 0
    mock_result.stdout = wrapper
    mock_result.stderr = ""
    mocker.patch("core.summarizer.shutil.which", return_value="/usr/bin/gemini")
    mock = mocker.patch("core.summarizer.subprocess.run", return_value=mock_result)
    return mock


@pytest.fixture
def mock_gemini_fail(mocker):
    """Patch subprocess.run to simulate Gemini CLI failure."""
    mocker.patch("core.summarizer.shutil.which", return_value="/usr/bin/gemini")
    mock = mocker.patch(
        "core.summarizer.subprocess.run",
        side_effect=RuntimeError("Gemini CLI not available"),
    )
    return mock


@pytest.fixture
def mock_gemini_not_found(mocker):
    """Patch shutil.which to simulate missing Gemini binary."""
    mock = mocker.patch("core.summarizer.shutil.which", return_value=None)
    return mock


@pytest.fixture
def mock_httpx_single(mocker):
    """Patch httpx.post to return a valid single-turn Ollama native response."""
    import json
    response_json = json.dumps({
        "title": "Fix stop price field",
        "summary": "Use aux_price not stop_price.",
        "classification": "fix",
        "important": True,
        "milestone": True,
    })
    mock_resp = mocker.Mock()
    mock_resp.raise_for_status = mocker.Mock()
    mock_resp.json.return_value = {
        "message": {"content": response_json},
        "done": True,
        "done_reason": "stop",
    }
    mock = mocker.patch("core.summarizer.httpx.post", return_value=mock_resp)
    return mock


@pytest.fixture
def mock_httpx_batch(mocker):
    """Patch httpx.post to return a valid batch Ollama native response."""
    import json
    response_json = json.dumps({
        "summaries": [
            {
                "turn_id": "u1",
                "title": "Fix stop price field",
                "summary": "Use aux_price not stop_price.",
                "classification": "fix",
                "important": True,
                "milestone": True,
            },
            {
                "turn_id": "u2",
                "title": "Set trailing stop type",
                "summary": "Use trailing_stop_type=1.",
                "classification": "feature",
                "important": False,
                "milestone": False,
            },
        ]
    })
    mock_resp = mocker.Mock()
    mock_resp.raise_for_status = mocker.Mock()
    mock_resp.json.return_value = {
        "message": {"content": response_json},
        "done": True,
        "done_reason": "stop",
    }
    mock = mocker.patch("core.summarizer.httpx.post", return_value=mock_resp)
    return mock


@pytest.fixture
def mock_httpx_fail(mocker):
    """Patch httpx.post to raise an error (simulates native Ollama failure)."""
    mock = mocker.patch(
        "core.summarizer.httpx.post",
        side_effect=RuntimeError("Ollama native API down"),
    )
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
def sample_turns():
    """Multiple Turn-like dicts for batch testing."""
    from core.models import Turn
    return [
        Turn(id="u1", timestamp="2026-02-19T10:00:00",
             user="why is the stop price wrong?",
             assistant="The field is aux_price not stop_price."),
        Turn(id="u2", timestamp="2026-02-19T10:01:00",
             user="how do I set trailing stop?",
             assistant="Use the trailing_stop_type field with value 1."),
    ]


@pytest.fixture
def mock_anthropic_batch(mocker):
    """Patch anthropic.Anthropic to return a batch summarizer response."""
    import json
    response_json = json.dumps({
        "summaries": [
            {
                "turn_id": "u1",
                "title": "Fix stop price field",
                "summary": "Use aux_price not stop_price.",
                "classification": "fix",
                "important": True,
                "milestone": True,
            },
            {
                "turn_id": "u2",
                "title": "Set trailing stop type",
                "summary": "Use trailing_stop_type=1.",
                "classification": "feature",
                "important": False,
                "milestone": False,
            },
        ]
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
