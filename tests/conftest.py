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
