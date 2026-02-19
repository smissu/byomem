from core.summarizer import (
    BATCH_SYSTEM,
    SYSTEM,
    _ollama_api_url,
    _wrap_bare_array,
    summarize_batch,
    summarize_turn,
)

# ---------------------------------------------------------------------------
# Single-turn tests (summarize_turn returns dict for backward compat)
# ---------------------------------------------------------------------------


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


def test_accepts_dict_input(sample_turn, mock_anthropic, tmp_byomem):
    """summarize_turn accepts both dict and Turn model."""
    result = summarize_turn(sample_turn)
    assert isinstance(result, dict)
    assert result["classification"] in ("fix", "decision", "feature", "research", "general")


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


# ---------------------------------------------------------------------------
# Batch tests (summarize_batch returns list[TurnSummary])
# ---------------------------------------------------------------------------


def test_batch_system_prompt_exists():
    assert "summaries" in BATCH_SYSTEM
    assert "turn_id" in BATCH_SYSTEM


def test_summarize_batch_single_turn(sample_turns, mock_anthropic, tmp_byomem):
    """Batch with 1 turn falls back to sequential and returns TurnSummary."""
    results = summarize_batch(sample_turns[:1])
    assert len(results) == 1
    assert results[0].classification == "fix"
    assert results[0].important is True


def test_summarize_batch_multiple_turns(sample_turns, mock_anthropic_batch, tmp_byomem):
    """Batch with multiple turns returns one TurnSummary per turn."""
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    assert results[1].title == "Set trailing stop type"


def test_summarize_batch_empty():
    assert summarize_batch([]) == []


def test_batch_fallback_on_error(sample_turns, mock_anthropic, tmp_byomem):
    """When batch and sequential both fail, returns default summaries."""
    mock_anthropic.return_value.messages.create.side_effect = RuntimeError("API down")
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    for r in results:
        assert r.classification == "general"
        assert r.important is False


# ---------------------------------------------------------------------------
# _wrap_bare_array tests
# ---------------------------------------------------------------------------


def test_wrap_bare_array_wraps_array():
    raw = '[{"turn_id":"t1","title":"Test"}]'
    assert _wrap_bare_array(raw) == '{"summaries":' + raw + '}'


def test_wrap_bare_array_passes_object():
    raw = '{"summaries":[{"turn_id":"t1","title":"Test"}]}'
    assert _wrap_bare_array(raw) == raw


def test_wrap_bare_array_handles_whitespace():
    raw = '  [{"turn_id":"t1"}]  '
    result = _wrap_bare_array(raw)
    assert result.startswith('{"summaries":')


# ---------------------------------------------------------------------------
# _ollama_api_url tests
# ---------------------------------------------------------------------------


def test_ollama_api_url_strips_v1():
    from core.config import Config
    cfg = Config(summarizer_base_url="http://localhost:11434/v1")
    assert _ollama_api_url(cfg) == "http://localhost:11434/api/chat"


def test_ollama_api_url_strips_trailing_slash():
    from core.config import Config
    cfg = Config(summarizer_base_url="http://localhost:11434/v1/")
    assert _ollama_api_url(cfg) == "http://localhost:11434/api/chat"


# ---------------------------------------------------------------------------
# Native Ollama path tests
# ---------------------------------------------------------------------------


def test_single_turn_uses_native(sample_turn, mock_httpx_single, tmp_byomem_ollama):
    """When base_url is set, summarize_turn tries native Ollama first."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_httpx_single.assert_called_once()
    call_json = mock_httpx_single.call_args.kwargs["json"]
    assert call_json["model"] == "qwen3:4b"
    assert call_json["think"] is False
    assert "format" in call_json


def test_single_turn_fallback_to_openai_compat(
    sample_turn, mock_httpx_fail, tmp_byomem_ollama, mocker,
):
    """When native fails, falls back to OpenAI-compat with fallback_model."""
    import json
    mock_openai = mocker.patch("core.summarizer.openai.OpenAI")
    mock_openai.return_value.chat.completions.create.return_value.choices = [
        mocker.Mock(message=mocker.Mock(content=json.dumps({
            "title": "Fallback result",
            "summary": "From OpenAI-compat.",
            "classification": "general",
            "important": False,
            "milestone": False,
        })))
    ]
    result = summarize_turn(sample_turn)
    assert result["title"] == "Fallback result"
    # Verify fallback model is used
    call_kwargs = mock_openai.return_value.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "qwen2.5:3b"


def test_batch_uses_native(sample_turns, mock_httpx_batch, tmp_byomem_ollama):
    """When base_url is set, summarize_batch tries native Ollama first."""
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    assert results[1].title == "Set trailing stop type"
    mock_httpx_batch.assert_called_once()
    call_json = mock_httpx_batch.call_args.kwargs["json"]
    assert call_json["model"] == "qwen3:4b"
    assert call_json["think"] is False


def test_batch_fallback_to_openai_compat(
    sample_turns, mock_httpx_fail, tmp_byomem_ollama, mocker,
):
    """When native batch fails, falls back to OpenAI-compat 3-tier."""
    import json
    batch_json = json.dumps({
        "summaries": [
            {"turn_id": "u1", "title": "T1", "summary": "S1",
             "classification": "fix", "important": False, "milestone": False},
            {"turn_id": "u2", "title": "T2", "summary": "S2",
             "classification": "feature", "important": False, "milestone": False},
        ]
    })
    mock_openai = mocker.patch("core.summarizer.openai.OpenAI")
    # Tier 1 fails
    mock_openai.return_value.beta.chat.completions.parse.side_effect = RuntimeError("no")
    # Tier 2 succeeds
    mock_openai.return_value.chat.completions.create.return_value.choices = [
        mocker.Mock(message=mocker.Mock(content=batch_json))
    ]
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "T1"
    # Verify fallback model is used
    call_kwargs = mock_openai.return_value.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "qwen2.5:3b"
