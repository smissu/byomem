from core.summarizer import (
    BATCH_SYSTEM,
    SYSTEM,
    _backend_order,
    _gemini_available,
    _lmstudio_available,
    _ollama_api_url,
    _strip_fences,
    _SUMMARIZER_BACKENDS,
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
    assert _wrap_bare_array(raw) == '{"summaries":' + raw + "}"


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
    assert call_json["model"] == "qwen3:8b"
    assert call_json["think"] is False
    assert "format" in call_json


def test_single_turn_fallback_to_openai_compat(
    sample_turn,
    mock_httpx_fail,
    tmp_byomem_ollama,
    mocker,
):
    """When native fails, falls back to OpenAI-compat with fallback_model."""
    import json

    mock_openai = mocker.patch("core.summarizer.openai.OpenAI")
    mock_openai.return_value.chat.completions.create.return_value.choices = [
        mocker.Mock(
            message=mocker.Mock(
                content=json.dumps(
                    {
                        "title": "Fallback result",
                        "summary": "From OpenAI-compat.",
                        "classification": "general",
                        "important": False,
                        "milestone": False,
                    }
                )
            )
        )
    ]
    result = summarize_turn(sample_turn)
    assert result["title"] == "Fallback result"
    # Verify fallback model is used
    call_kwargs = mock_openai.return_value.chat.completions.create.call_args.kwargs
    assert call_kwargs["model"] == "qwen3:8b"


def test_batch_uses_native(sample_turns, mock_httpx_batch, tmp_byomem_ollama):
    """When base_url is set, summarize_batch tries native Ollama first."""
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    assert results[1].title == "Set trailing stop type"
    mock_httpx_batch.assert_called_once()
    call_json = mock_httpx_batch.call_args.kwargs["json"]
    assert call_json["model"] == "qwen3:8b"
    assert call_json["think"] is False


def test_batch_fallback_to_openai_compat(
    sample_turns,
    mock_httpx_fail,
    tmp_byomem_ollama,
    mocker,
):
    """When native batch fails, falls back to OpenAI-compat 3-tier."""
    import json

    batch_json = json.dumps(
        {
            "summaries": [
                {
                    "turn_id": "u1",
                    "title": "T1",
                    "summary": "S1",
                    "classification": "fix",
                    "important": False,
                    "milestone": False,
                },
                {
                    "turn_id": "u2",
                    "title": "T2",
                    "summary": "S2",
                    "classification": "feature",
                    "important": False,
                    "milestone": False,
                },
            ]
        }
    )
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
    assert call_kwargs["model"] == "qwen3:8b"


# ---------------------------------------------------------------------------
# Gemini CLI path tests
# ---------------------------------------------------------------------------


def test_single_turn_uses_gemini(sample_turn, mock_gemini_single, tmp_byomem_gemini):
    """When gemini_cli is configured, summarize_turn tries Gemini first."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_gemini_single.assert_called_once()


def test_batch_uses_gemini(sample_turns, mock_gemini_batch, tmp_byomem_gemini):
    """When gemini_cli is configured, summarize_batch tries Gemini first."""
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    assert results[1].title == "Set trailing stop type"
    mock_gemini_batch.assert_called_once()


def test_gemini_fallback_to_ollama_on_failure(
    sample_turn,
    mock_gemini_fail,
    mock_httpx_single,
    tmp_byomem_gemini,
):
    """When Gemini CLI fails, falls back to native Ollama."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_httpx_single.assert_called_once()


def test_gemini_skipped_when_not_installed(
    sample_turn,
    mock_gemini_not_found,
    mock_httpx_single,
    tmp_byomem_gemini,
):
    """When shutil.which returns None, Gemini is skipped entirely."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    # Gemini subprocess should NOT have been called
    mock_httpx_single.assert_called_once()


def test_gemini_skipped_for_model_override(
    sample_turn,
    mock_gemini_single,
    tmp_byomem_gemini,
    mocker,
):
    """model_override (overflow worker) bypasses Gemini CLI."""
    import json

    mock_openai = mocker.patch("core.summarizer.openai.OpenAI")
    mock_openai.return_value.chat.completions.create.return_value.choices = [
        mocker.Mock(
            message=mocker.Mock(
                content=json.dumps(
                    {
                        "title": "Overflow result",
                        "summary": "From overflow.",
                        "classification": "general",
                        "important": False,
                        "milestone": False,
                    }
                )
            )
        )
    ]
    result = summarize_turn(sample_turn, model_override="qwen3:8b")
    assert result["title"] == "Overflow result"
    mock_gemini_single.assert_not_called()


def test_gemini_handles_fenced_response():
    """_strip_fences handles ```json blocks from Gemini output."""
    fenced = '```json\n{"title": "Test"}\n```'
    assert _strip_fences(fenced) == '{"title": "Test"}'


def test_gemini_timeout_falls_through(
    sample_turn,
    mock_httpx_single,
    tmp_byomem_gemini,
    mocker,
):
    """subprocess.TimeoutExpired from Gemini falls through to Ollama."""
    import subprocess

    mocker.patch("core.summarizer.shutil.which", return_value="/usr/bin/gemini")
    mocker.patch(
        "core.summarizer.subprocess.run",
        side_effect=subprocess.TimeoutExpired(cmd="gemini", timeout=90),
    )
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    mock_httpx_single.assert_called_once()


def test_gemini_available_returns_false_when_not_configured(tmp_byomem):
    """_gemini_available returns False when gemini_cli is None."""
    from core.config import get_config

    cfg = get_config()
    assert not _gemini_available(cfg)


# ---------------------------------------------------------------------------
# LM Studio backend tests
# ---------------------------------------------------------------------------


def test_single_turn_uses_lmstudio(sample_turn, mock_lmstudio_single, tmp_byomem_lmstudio):
    """When lmstudio_url is configured, summarize_turn tries LM Studio."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_lmstudio_single.assert_called_once_with(
        base_url="http://localhost:1234/v1",
        api_key="lm-studio",
    )


def test_batch_uses_lmstudio(sample_turns, mock_lmstudio_batch, tmp_byomem_lmstudio):
    """When lmstudio_url is configured, summarize_batch tries LM Studio."""
    results = summarize_batch(sample_turns)
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    assert results[1].title == "Set trailing stop type"
    mock_lmstudio_batch.assert_called_once()


def test_lmstudio_fallback_to_ollama_on_failure(
    sample_turn,
    mock_lmstudio_fail,
    mock_httpx_single,
    tmp_byomem_lmstudio,
):
    """When LM Studio fails, falls back to native Ollama."""
    result = summarize_turn(sample_turn)
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_httpx_single.assert_called_once()


def test_lmstudio_skipped_when_not_configured(sample_turn, mock_anthropic, tmp_byomem):
    """When lmstudio_url is not set, LM Studio is skipped entirely."""
    from core.config import get_config

    cfg = get_config()
    assert not _lmstudio_available(cfg)
    result = summarize_turn(sample_turn)
    assert isinstance(result, dict)


def test_lmstudio_skipped_for_model_override(
    sample_turn,
    mock_lmstudio_single,
    tmp_byomem_lmstudio,
    mocker,
):
    """model_override (overflow worker) bypasses LM Studio."""
    import json

    mock_openai = mocker.patch("core.summarizer.openai.OpenAI")
    mock_openai.return_value.chat.completions.create.return_value.choices = [
        mocker.Mock(
            message=mocker.Mock(
                content=json.dumps(
                    {
                        "title": "Overflow result",
                        "summary": "From overflow.",
                        "classification": "general",
                        "important": False,
                        "milestone": False,
                    }
                )
            )
        )
    ]
    result = summarize_turn(sample_turn, model_override="qwen3:8b")
    assert result["title"] == "Overflow result"
    # LM Studio should NOT have been called directly
    mock_lmstudio_single.assert_not_called()


# ---------------------------------------------------------------------------
# Backend registry + dispatch tests
# ---------------------------------------------------------------------------


def test_backend_order_preferred_first():
    """_backend_order puts preferred backend first, others follow."""
    order = _backend_order("zai", _SUMMARIZER_BACKENDS)
    assert order[0] == "zai"
    assert "gemini" in order
    assert "anthropic" in order
    # No duplicates
    assert len(order) == len(set(order))


def test_backend_order_unknown_preferred():
    """_backend_order with unknown preferred returns all in default order."""
    order = _backend_order("nonexistent", _SUMMARIZER_BACKENDS)
    assert "nonexistent" not in order
    assert order[0] == "gemini"  # first in registry


def test_registry_has_all_backends():
    """Registry contains all expected backend names."""
    expected = {"gemini", "opencode", "zai", "lmstudio", "ollama", "anthropic"}
    assert set(_SUMMARIZER_BACKENDS.keys()) == expected


def test_single_turn_backend_dispatch(sample_turn, mock_gemini_single, tmp_byomem_gemini):
    """backend='gemini' dispatches to Gemini via registry."""
    result = summarize_turn(sample_turn, backend="gemini")
    assert result["classification"] == "fix"
    assert result["title"] == "Fix stop price field"
    mock_gemini_single.assert_called_once()


def test_single_turn_backend_fallthrough(
    sample_turn, mock_gemini_fail, mock_anthropic, tmp_byomem_gemini,
):
    """When preferred backend fails, falls through to next available."""
    result = summarize_turn(sample_turn, backend="gemini")
    assert isinstance(result, dict)
    # Gemini failed, should have fallen through to anthropic (or another)
    assert result["classification"] in ("fix", "general")


def test_batch_backend_dispatch(sample_turns, mock_gemini_batch, tmp_byomem_gemini):
    """backend='gemini' dispatches batch to Gemini via registry."""
    results = summarize_batch(sample_turns, backend="gemini")
    assert len(results) == 2
    assert results[0].title == "Fix stop price field"
    mock_gemini_batch.assert_called_once()


def test_batch_backend_fallthrough(
    sample_turns, mock_gemini_fail, mock_anthropic_batch, tmp_byomem_gemini,
):
    """When preferred backend fails in batch, falls through to next."""
    results = summarize_batch(sample_turns, backend="gemini")
    assert len(results) == 2


def test_backend_none_uses_cascade(sample_turn, mock_anthropic, tmp_byomem):
    """backend=None uses existing cascade (backward compat)."""
    result = summarize_turn(sample_turn, backend=None)
    assert isinstance(result, dict)
    assert result["classification"] == "fix"
