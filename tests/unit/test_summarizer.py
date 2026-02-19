from core.summarizer import SYSTEM, summarize_turn


def test_returns_valid_json(sample_turn, mock_anthropic, tmp_byomem):
    result = summarize_turn(sample_turn)
    assert isinstance(result, dict)
    for key in ("title", "summary", "classification", "important", "milestone"):
        assert key in result


def test_passes_turn_to_haiku(sample_turn, mock_anthropic, tmp_byomem):
    summarize_turn(sample_turn)
    call_kwargs = mock_anthropic.return_value.messages.create.call_args
    assert call_kwargs.kwargs["model"] == "claude-haiku-4-5-20251001"
    content = call_kwargs.kwargs["messages"][0]["content"]
    assert sample_turn["user"] in content
    assert sample_turn["assistant"] in content


def test_fallback_on_bad_json(sample_turn, mock_anthropic, tmp_byomem):
    mock_anthropic.return_value.messages.create.return_value.content[0].text = "not json"
    result = summarize_turn(sample_turn)
    assert result["classification"] == "general"
    assert result["important"] is False
    assert result["milestone"] is False


def test_fallback_on_api_error(sample_turn, mock_anthropic, tmp_byomem):
    mock_anthropic.return_value.messages.create.side_effect = RuntimeError("API down")
    result = summarize_turn(sample_turn)
    assert result["classification"] == "general"
    assert result["important"] is False


def test_system_prompt_has_json_fields():
    for field in ("title", "summary", "classification", "important", "milestone"):
        assert field in SYSTEM
