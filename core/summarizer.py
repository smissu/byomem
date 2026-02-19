"""LLM-powered turn summarization — single and batch modes."""

import json
import logging

import anthropic
import httpx
import openai

from core.config import get_config
from core.models import BatchSummaryResponse, Turn, TurnSummary

logger = logging.getLogger(__name__)

SYSTEM = """You are a coding session analyzer. Summarize this exchange concisely.

Return valid JSON only:
{
  "title": "5-10 word imperative title",
  "summary": "2-3 sentences: what was done or decided",
  "classification": "fix|decision|feature|research|general",
  "important": true|false,
  "milestone": true|false
}

important=true: non-obvious fix, architectural decision, pattern to remember, gotcha
milestone=true: meaningful unit of work completed (bug fixed, approach validated, v1 done)
Both false for: routine edits, simple questions, exploratory work."""

BATCH_SYSTEM = """You are a coding session analyzer. You will receive multiple turns, \
each delimited by --- Turn {id} ---.
Summarize EVERY turn. Return valid JSON only:
{
  "summaries": [
    {
      "turn_id": "<the id from the delimiter>",
      "title": "5-10 word imperative title",
      "summary": "2-3 sentences: what was done or decided",
      "classification": "fix|decision|feature|research|general",
      "important": true|false,
      "milestone": true|false
    }
  ]
}

Match each summary to its turn by turn_id, not by array position.

important=true: non-obvious fix, architectural decision, pattern to remember, gotcha
milestone=true: meaningful unit of work completed (bug fixed, approach validated, v1 done)
Both false for: routine edits, simple questions, exploratory work."""

FALLBACK = {
    "title": "Session turn",
    "summary": "",
    "classification": "general",
    "important": False,
    "milestone": False,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _strip_fences(text: str) -> str:
    """Strip markdown code fences from LLM response."""
    text = text.strip()
    if text.startswith("```"):
        text = "\n".join(text.splitlines()[1:])
        if text.strip().endswith("```"):
            text = "\n".join(text.strip().splitlines()[:-1])
    return text.strip()


def _wrap_bare_array(text: str) -> str:
    """Wrap a bare JSON array in {"summaries": [...]}.

    Small models often return just the array instead of the wrapper object.
    """
    stripped = text.strip()
    if stripped.startswith("["):
        return '{"summaries":' + stripped + '}'
    return stripped


def _coerce_turn(turn) -> Turn:
    """Accept a Turn model or a dict and return a Turn instance."""
    if isinstance(turn, Turn):
        return turn
    return Turn(**turn)


def _format_single(turn: Turn, cfg) -> str:
    """Format a single turn into the user-message payload."""
    return (
        f"User: {turn.user[:cfg.user_message_max]}\n\n"
        f"Claude: {turn.assistant[:cfg.assistant_message_max]}"
    )


def _format_batch(turns: list[Turn], cfg) -> str:
    """Format multiple turns into a single user-message payload."""
    parts = []
    for t in turns:
        parts.append(
            f"--- Turn {t.id} ---\n"
            f"User: {t.user[:cfg.user_message_max]}\n\n"
            f"Claude: {t.assistant[:cfg.assistant_message_max]}"
        )
    return "\n\n".join(parts)


def _ollama_api_url(cfg) -> str:
    """Derive native Ollama /api/chat URL from OpenAI-compat base_url."""
    base = cfg.summarizer_base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return base + "/api/chat"


# ---------------------------------------------------------------------------
# Single-turn summarization (backward compatible — returns dict)
# ---------------------------------------------------------------------------

def summarize_turn(turn) -> dict:
    """Summarize a single turn. Accepts Turn model or dict. Returns dict."""
    cfg = get_config()
    t = _coerce_turn(turn)
    user_content = _format_single(t, cfg)
    try:
        if cfg.summarizer_base_url:
            try:
                return _summarize_ollama_native(cfg, user_content)
            except Exception:
                logger.debug("Native Ollama single-turn failed", exc_info=True)
            return _summarize_openai_compat(cfg, user_content)
        return _summarize_anthropic(cfg, user_content)
    except Exception:
        return dict(FALLBACK)


def _summarize_anthropic(cfg, user_content: str) -> dict:
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=cfg.summarizer_model,
        max_tokens=cfg.summarizer_max_tokens,
        system=SYSTEM,
        messages=[{"role": "user", "content": user_content}],
    )
    return json.loads(_strip_fences(resp.content[0].text))


def _summarize_ollama_native(cfg, user_content: str) -> dict:
    """Native Ollama /api/chat with JSON schema constraint.

    Bypasses thinking tokens by using format schema + think=false.
    """
    resp = httpx.post(
        _ollama_api_url(cfg),
        json={
            "model": cfg.summarizer_model,
            "stream": False,
            "think": False,
            "format": TurnSummary.model_json_schema(),
            "options": {"num_predict": cfg.summarizer_max_tokens},
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=60.0,
    )
    resp.raise_for_status()
    text = resp.json()["message"]["content"]
    if not text or not text.strip():
        raise ValueError("Empty response from Ollama native API")
    return json.loads(_strip_fences(text))


def _summarize_openai_compat(cfg, user_content: str) -> dict:
    """OpenAI-compat fallback path (uses fallback_model if configured)."""
    model = cfg.summarizer_fallback_model or cfg.summarizer_model
    client = openai.OpenAI(base_url=cfg.summarizer_base_url, api_key="ollama")
    resp = client.chat.completions.create(
        model=model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_content},
        ],
    )
    return json.loads(_strip_fences(resp.choices[0].message.content))


# ---------------------------------------------------------------------------
# Batch summarization
# ---------------------------------------------------------------------------

def summarize_batch(turns: list) -> list[TurnSummary]:
    """Summarize multiple turns in a single LLM call.

    Returns a list of TurnSummary in the same order as the input turns.
    Falls back to sequential single-turn calls if batch parsing fails.
    """
    if not turns:
        return []
    cfg = get_config()
    coerced = [_coerce_turn(t) for t in turns]
    user_content = _format_batch(coerced, cfg)

    try:
        if cfg.summarizer_base_url:
            try:
                batch_resp = _batch_ollama_native(cfg, user_content)
                return _align_results(coerced, batch_resp)
            except Exception:
                logger.debug("Native Ollama batch failed, trying OpenAI-compat", exc_info=True)
            batch_resp = _batch_openai_compat(cfg, user_content)
        else:
            batch_resp = _batch_anthropic(cfg, user_content)
        return _align_results(coerced, batch_resp)
    except Exception:
        logger.debug("Batch parse failed, falling back to sequential", exc_info=True)
        return _sequential_fallback(coerced)


def _batch_anthropic(cfg, user_content: str) -> BatchSummaryResponse:
    """Anthropic path: plain text response, parse as JSON."""
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=cfg.summarizer_model,
        max_tokens=cfg.summarizer_max_tokens,
        system=BATCH_SYSTEM,
        messages=[{"role": "user", "content": user_content}],
    )
    text = _wrap_bare_array(_strip_fences(resp.content[0].text))
    return BatchSummaryResponse.model_validate_json(text)


def _batch_ollama_native(cfg, user_content: str) -> BatchSummaryResponse:
    """Native Ollama /api/chat for batch with JSON schema constraint.

    Bypasses thinking tokens by using format schema + think=false.
    """
    resp = httpx.post(
        _ollama_api_url(cfg),
        json={
            "model": cfg.summarizer_model,
            "stream": False,
            "think": False,
            "format": BatchSummaryResponse.model_json_schema(),
            "options": {"num_predict": cfg.summarizer_max_tokens},
            "messages": [
                {"role": "system", "content": BATCH_SYSTEM},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=60.0,
    )
    resp.raise_for_status()
    text = resp.json()["message"]["content"]
    if not text or not text.strip():
        raise ValueError("Empty response from Ollama native API")
    text = _wrap_bare_array(_strip_fences(text))
    return BatchSummaryResponse.model_validate_json(text)


def _batch_openai_compat(cfg, user_content: str) -> BatchSummaryResponse:
    """OpenAI-compat fallback with 3-tier structured output strategy.

    Uses fallback_model if configured (for when primary is a thinking model).
    """
    model = cfg.summarizer_fallback_model or cfg.summarizer_model
    client = openai.OpenAI(base_url=cfg.summarizer_base_url, api_key="ollama")
    messages = [
        {"role": "system", "content": BATCH_SYSTEM},
        {"role": "user", "content": user_content},
    ]

    # Tier 1: OpenAI structured output (beta.chat.completions.parse)
    try:
        resp = client.beta.chat.completions.parse(
            model=model,
            max_tokens=cfg.summarizer_max_tokens,
            messages=messages,
            response_format=BatchSummaryResponse,
        )
        parsed = resp.choices[0].message.parsed
        if parsed is not None:
            return parsed
    except Exception:
        logger.debug("Tier 1 (structured output) failed", exc_info=True)

    # Tier 2: Ollama native JSON schema via extra_body
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=cfg.summarizer_max_tokens,
            messages=messages,
            extra_body={"format": BatchSummaryResponse.model_json_schema()},
        )
        text = _wrap_bare_array(_strip_fences(resp.choices[0].message.content))
        return BatchSummaryResponse.model_validate_json(text)
    except Exception:
        logger.debug("Tier 2 (Ollama format) failed", exc_info=True)

    # Tier 3: Plain text, parse manually
    resp = client.chat.completions.create(
        model=model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=messages,
    )
    text = _wrap_bare_array(_strip_fences(resp.choices[0].message.content))
    return BatchSummaryResponse.model_validate_json(text)


def _align_results(
    turns: list[Turn], batch_resp: BatchSummaryResponse,
) -> list[TurnSummary]:
    """Match batch summaries to input turns by turn_id, preserving input order."""
    by_id = {item.turn_id: item for item in batch_resp.summaries}
    results: list[TurnSummary] = []
    for t in turns:
        item = by_id.get(t.id)
        if item is not None:
            results.append(TurnSummary(
                title=item.title,
                summary=item.summary,
                classification=item.classification,
                important=item.important,
                milestone=item.milestone,
            ))
        else:
            results.append(TurnSummary(**FALLBACK))
    return results


def _sequential_fallback(turns: list[Turn]) -> list[TurnSummary]:
    """Fall back to one-at-a-time summarization when batch fails."""
    results: list[TurnSummary] = []
    for t in turns:
        raw = summarize_turn(t)
        results.append(TurnSummary(**raw))
    return results
