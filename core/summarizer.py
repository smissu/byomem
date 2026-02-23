"""LLM-powered turn summarization — single and batch modes."""

import json
import logging
import shutil
import subprocess
import threading
from datetime import UTC, datetime

import anthropic
import httpx
import openai

from core.config import get_config
from core.models import BatchSummaryResponse, Turn, TurnSummary

logger = logging.getLogger(__name__)
_debug_lock = threading.Lock()
_thread_local = threading.local()

SYSTEM = """You are a coding session analyzer. Summarize this exchange concisely.

Return ONLY valid JSON matching this exact schema — no commentary, no markdown fences, \
no echoing of the template:
{
  "title": "5-10 word imperative title",
  "summary": "2-3 sentences: what was done or decided",
  "classification": "fix|decision|feature|research|general",
  "important": true|false,
  "milestone": true|false
}

Rules:
- title: imperative verb phrase, 5-10 words, specific to what happened
- summary: 2-3 sentences with concrete details — names, values, files
- PRESERVE IDENTIFIERS: always include sprint numbers, task IDs, file paths, function names, \
error codes, model names, and config values in both title and summary. These are critical \
for later retrieval.
- classification: fix (bug fix), decision (architectural choice), feature (new capability), \
research (exploration), general (other)
- important: true for non-obvious fixes, architectural decisions, patterns to remember, gotchas
- milestone: true for meaningful completed work (bug fixed, approach validated, v1 done)
- Both false for routine edits, simple questions, exploratory work

Example input:
User: why is the stop price not updating when I modify the order?
Claude: The field is aux_price not stop_price in the IB API. Change order.stop_price to \
order.auxPrice.

Example output:
{"title": "Fix stop price field to use auxPrice", "summary": "The modify-order endpoint \
requires auxPrice instead of stop_price. Changed order.stop_price to order.auxPrice for IB \
API compatibility.", "classification": "fix", "important": true, "milestone": false}

Example input:
User: implement the profit action processor for sprint 37
Claude: Added ProfitActionProcessor to position_monitor.py at priority 2.75. Created \
test_profit_actions.py with 6 tests. Wired into PositionMonitor.__init__ via optional injection.

Example output:
{"title": "Sprint 37: Implement ProfitActionProcessor in position_monitor.py", \
"summary": "Added ProfitActionProcessor at priority 2.75 in position_monitor.py, between \
long-leg tradeability check and decay re-entry. Created test_profit_actions.py with 6 tests \
covering the bridge and min-comparison formula.", \
"classification": "feature", "important": true, "milestone": true}

DO NOT echo the template. Return ONLY the JSON object."""

BATCH_SYSTEM = """You are a coding session analyzer. You will receive multiple turns, \
each delimited by --- Turn {id} ---.
Summarize EVERY turn. Return ONLY valid JSON — no commentary, no markdown fences, \
no echoing of the template:
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

Rules:
- Match each summary to its turn by turn_id, not by array position
- title: imperative verb phrase, 5-10 words, specific to what happened
- summary: 2-3 sentences with concrete details — names, values, files
- PRESERVE IDENTIFIERS: always include sprint numbers, task IDs, file paths, function names, \
error codes, model names, and config values in both title and summary. These are critical \
for later retrieval.
- classification: fix (bug fix), decision (architectural choice), feature (new capability), \
research (exploration), general (other)
- important: true for non-obvious fixes, architectural decisions, patterns to remember, gotchas
- milestone: true for meaningful completed work (bug fixed, approach validated, v1 done)
- Both false for routine edits, simple questions, exploratory work

DO NOT echo the template. Return ONLY the JSON object."""

FALLBACK = {
    "title": "Session turn",
    "summary": "",
    "classification": "general",
    "important": False,
    "milestone": False,
}


# ---------------------------------------------------------------------------
# Backend tracking (thread-safe)
# ---------------------------------------------------------------------------


def reset_backend_log():
    """Clear the backend log for this thread. Call before processing a job."""
    _thread_local.backends = []


def get_backend_log() -> list[str]:
    """Return list of backends used in this thread since last reset."""
    return getattr(_thread_local, "backends", [])


def get_primary_backend() -> str:
    """Return the most-used backend, or empty string if none recorded."""
    backends = get_backend_log()
    if not backends:
        return ""
    # Return most frequent
    counts = {}
    for b in backends:
        counts[b] = counts.get(b, 0) + 1
    return max(counts, key=counts.get)


def _track_backend(name: str):
    """Record a backend usage for this thread."""
    if not hasattr(_thread_local, "backends"):
        _thread_local.backends = []
    _thread_local.backends.append(name)


# ---------------------------------------------------------------------------
# Debug logging
# ---------------------------------------------------------------------------


def _debug_log(entry: dict):
    """Append a debug entry to queue/summarizer_debug.jsonl if debug mode is on."""
    cfg = get_config()
    if not cfg.summarizer_debug:
        return
    debug_path = cfg.queue_path / "summarizer_debug.jsonl"
    debug_path.parent.mkdir(parents=True, exist_ok=True)
    entry["ts"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with _debug_lock:
        with open(debug_path, "a") as f:
            f.write(json.dumps(entry) + "\n")


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
        return '{"summaries":' + stripped + "}"
    return stripped


def _coerce_turn(turn) -> Turn:
    """Accept a Turn model or a dict and return a Turn instance."""
    if isinstance(turn, Turn):
        return turn
    return Turn(**turn)


def _format_single(turn: Turn, cfg) -> str:
    """Format a single turn into the user-message payload."""
    return (
        f"User: {turn.user[: cfg.user_message_max]}\n\n"
        f"Claude: {turn.assistant[: cfg.assistant_message_max]}"
    )


def _format_batch(turns: list[Turn], cfg) -> str:
    """Format multiple turns into a single user-message payload."""
    parts = []
    for t in turns:
        parts.append(
            f"--- Turn {t.id} ---\n"
            f"User: {t.user[: cfg.user_message_max]}\n\n"
            f"Claude: {t.assistant[: cfg.assistant_message_max]}"
        )
    return "\n\n".join(parts)


def _ollama_api_url(cfg) -> str:
    """Derive native Ollama /api/chat URL from OpenAI-compat base_url."""
    base = cfg.summarizer_base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return base + "/api/chat"


# ---------------------------------------------------------------------------
# Gemini CLI backend
# ---------------------------------------------------------------------------


def _gemini_available(cfg) -> bool:
    """Check if Gemini CLI is configured and the binary exists."""
    return bool(cfg.summarizer_gemini_cli and shutil.which(cfg.summarizer_gemini_cli))


def _run_gemini(cfg, prompt: str, *, model: str | None = None) -> str:
    """Run Gemini CLI and return the response text from the JSON envelope.

    If model is None, uses cfg.summarizer_gemini_model. On failure, retries
    with cfg.summarizer_gemini_fallback_model if configured.
    """
    primary = model or cfg.summarizer_gemini_model
    models_to_try = [primary]
    fallback = cfg.summarizer_gemini_fallback_model
    if fallback and fallback != primary:
        models_to_try.append(fallback)

    last_err = None
    for m in models_to_try:
        cmd = [cfg.summarizer_gemini_cli, "-p", prompt, "-o", "json"]
        if m:
            cmd.extend(["-m", m])
        result = subprocess.run(
            cmd,
            input="",
            capture_output=True,
            text=True,
            timeout=90,
            process_group=0,
        )
        if result.returncode != 0:
            last_err = RuntimeError(f"Gemini CLI failed (rc={result.returncode}): {result.stderr[:200]}")
            if len(models_to_try) > 1:
                logger.info("Gemini model %s failed, trying fallback %s", m, models_to_try[-1])
            continue
        wrapper = json.loads(result.stdout)
        response_text = wrapper.get("response", "")
        if not response_text or not response_text.strip():
            last_err = ValueError("Empty response from Gemini CLI")
            continue
        if m and m != primary:
            _track_backend(m)  # record fallback model used
        return response_text

    raise last_err


def _summarize_gemini(cfg, user_content: str) -> dict:
    """Summarize a single turn via Gemini CLI."""
    prompt = SYSTEM + "\n\n" + user_content
    return json.loads(_strip_fences(_run_gemini(cfg, prompt)))


def _batch_gemini(cfg, user_content: str) -> BatchSummaryResponse:
    """Batch summarize via Gemini CLI."""
    prompt = BATCH_SYSTEM + "\n\n" + user_content
    text = _wrap_bare_array(_strip_fences(_run_gemini(cfg, prompt)))
    return BatchSummaryResponse.model_validate_json(text)


# ---------------------------------------------------------------------------
# OpenCode CLI backend
# ---------------------------------------------------------------------------


def _opencode_available(cfg) -> bool:
    """Check if OpenCode CLI is configured and the binary exists."""
    return bool(cfg.summarizer_opencode_cli and shutil.which(cfg.summarizer_opencode_cli))


def _run_opencode(cfg, prompt: str) -> str:
    """Run OpenCode CLI and return the response text."""
    cmd = [
        cfg.summarizer_opencode_cli,
        "run",
        prompt,
        "-m",
        cfg.summarizer_opencode_model,
        "--format",
        "json",
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=120,
        process_group=0,
    )
    if result.returncode != 0:
        raise RuntimeError(f"OpenCode CLI failed (rc={result.returncode}): {result.stderr[:200]}")
    # Parse NDJSON: collect type="text" parts
    text_parts = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "text":
            text_parts.append(event["part"]["text"])

    response_text = "".join(text_parts)
    if not response_text.strip():
        raise ValueError("Empty response from OpenCode CLI")
    return response_text


def _summarize_opencode(cfg, user_content: str) -> dict:
    """Summarize a single turn via OpenCode CLI."""
    prompt = SYSTEM + "\n\n" + user_content
    return json.loads(_strip_fences(_run_opencode(cfg, prompt)))


def _batch_opencode(cfg, user_content: str) -> BatchSummaryResponse:
    """Batch summarize via OpenCode CLI."""
    prompt = BATCH_SYSTEM + "\n\n" + user_content
    text = _wrap_bare_array(_strip_fences(_run_opencode(cfg, prompt)))
    return BatchSummaryResponse.model_validate_json(text)


# ---------------------------------------------------------------------------
# Z.ai backend (OpenAI-compatible cloud, GLM models)
# ---------------------------------------------------------------------------


def _zai_available(cfg) -> bool:
    """Check if Z.ai is configured (URL and API key must be set)."""
    import os

    _load_zai_env()
    return bool(cfg.descripterizer_zai_url and os.environ.get("ZAI_API_KEY"))


def _load_zai_env():
    """Load .env file for ZAI_API_KEY if not already set."""
    import os
    from pathlib import Path

    if os.environ.get("ZAI_API_KEY"):
        return
    for env_path in [Path.home() / ".byomem" / ".env", Path(__file__).resolve().parent.parent / ".env"]:
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line and "=" in line and not line.startswith("#"):
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip())
            break


def _call_zai(cfg, system_prompt: str, user_content: str) -> str:
    """Call Z.ai API and return raw text response."""
    import os

    api_key = os.environ.get("ZAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("ZAI_API_KEY not set")
    client = openai.OpenAI(api_key=api_key, base_url=cfg.descripterizer_zai_url)
    resp = client.chat.completions.create(
        model=cfg.descripterizer_zai_model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    text = resp.choices[0].message.content or ""
    # Reasoning models may put content in model_extra
    if not text.strip() and hasattr(resp.choices[0].message, "model_extra"):
        extra = resp.choices[0].message.model_extra or {}
        text = extra.get("reasoning_content", "")
    text = _strip_fences(text)
    # GLM models sometimes prefix JSON with narrative text
    if text and not text.lstrip().startswith("{"):
        idx = text.find("{")
        if idx >= 0:
            text = text[idx:]
    return text


def _summarize_zai(cfg, user_content: str) -> dict:
    """Summarize a single turn via Z.ai."""
    return json.loads(_call_zai(cfg, SYSTEM, user_content))


def _batch_zai(cfg, user_content: str) -> BatchSummaryResponse:
    """Batch summarize via Z.ai."""
    text = _wrap_bare_array(_call_zai(cfg, BATCH_SYSTEM, user_content))
    return BatchSummaryResponse.model_validate_json(text)


# ---------------------------------------------------------------------------
# LM Studio backend (OpenAI-compatible local server)
# ---------------------------------------------------------------------------


def _lmstudio_available(cfg) -> bool:
    """Check if LM Studio is configured (URL must be set)."""
    return bool(cfg.summarizer_lmstudio_url)


def _summarize_lmstudio(cfg, user_content: str) -> dict:
    """Summarize a single turn via LM Studio's OpenAI-compatible API."""
    model = cfg.summarizer_lmstudio_model or "default"
    client = openai.OpenAI(base_url=cfg.summarizer_lmstudio_url, api_key="lm-studio")
    resp = client.chat.completions.create(
        model=model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_content},
        ],
    )
    return json.loads(_strip_fences(resp.choices[0].message.content))


def _batch_lmstudio(cfg, user_content: str) -> BatchSummaryResponse:
    """Batch summarize via LM Studio's OpenAI-compatible API."""
    model = cfg.summarizer_lmstudio_model or "default"
    client = openai.OpenAI(base_url=cfg.summarizer_lmstudio_url, api_key="lm-studio")
    resp = client.chat.completions.create(
        model=model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=[
            {"role": "system", "content": BATCH_SYSTEM},
            {"role": "user", "content": user_content},
        ],
    )
    text = _wrap_bare_array(_strip_fences(resp.choices[0].message.content))
    return BatchSummaryResponse.model_validate_json(text)


# ---------------------------------------------------------------------------
# Single-turn summarization (backward compatible — returns dict)
# ---------------------------------------------------------------------------


def summarize_turn(turn, *, backend: str | None = None, model_override: str | None = None) -> dict:
    """Summarize a single turn. Accepts Turn model or dict. Returns dict.

    If backend is set, dispatch via registry (preferred first, fall through).
    If model_override is set, skips Gemini CLI and the native Ollama path,
    going directly to OpenAI-compat (used by overflow worker).
    """
    cfg = get_config()
    t = _coerce_turn(turn)
    user_content = _format_single(t, cfg)
    result = None
    backend_used = "unknown"
    try:
        # Work-stealing dispatch: use registry when backend is specified
        if backend and not model_override:
            for name in _backend_order(backend, _SUMMARIZER_BACKENDS):
                avail_fn, single_fn, _, label_fn = _SUMMARIZER_BACKENDS[name]
                if not avail_fn(cfg):
                    continue
                try:
                    result = single_fn(cfg, user_content)
                    backend_used = label_fn(cfg)
                    return result
                except Exception:
                    logger.debug("Backend %s single-turn failed", name, exc_info=True)
            # All registry backends failed — fall through to fallback
            result = dict(FALLBACK)
            backend_used = "fallback"
            return result

        # Gemini CLI is primary when configured (skip for overflow workers)
        if _gemini_available(cfg) and not model_override:
            try:
                result = _summarize_gemini(cfg, user_content)
                backend_used = cfg.summarizer_gemini_model or "gemini"
                return result
            except Exception:
                logger.debug("Gemini CLI single-turn failed", exc_info=True)
        # OpenCode CLI is secondary cloud backend (skip for overflow workers)
        if _opencode_available(cfg) and not model_override:
            try:
                result = _summarize_opencode(cfg, user_content)
                backend_used = cfg.summarizer_opencode_model or "opencode"
                return result
            except Exception:
                logger.debug("OpenCode CLI single-turn failed", exc_info=True)
        # Z.ai cloud backend (skip for overflow workers)
        if _zai_available(cfg) and not model_override:
            try:
                result = _summarize_zai(cfg, user_content)
                backend_used = cfg.descripterizer_zai_model
                return result
            except Exception:
                logger.debug("Z.ai single-turn failed", exc_info=True)
        # LM Studio local backend (skip for overflow workers)
        if _lmstudio_available(cfg) and not model_override:
            try:
                result = _summarize_lmstudio(cfg, user_content)
                backend_used = cfg.summarizer_lmstudio_model or "lmstudio"
                return result
            except Exception:
                logger.debug("LM Studio single-turn failed", exc_info=True)
        if cfg.summarizer_base_url:
            if model_override:
                result = _summarize_openai_compat(cfg, user_content, model=model_override)
                backend_used = f"openai-compat/{model_override}"
                return result
            try:
                result = _summarize_ollama_native(cfg, user_content)
                backend_used = "ollama-native"
                return result
            except Exception:
                logger.debug("Native Ollama single-turn failed", exc_info=True)
            result = _summarize_openai_compat(cfg, user_content)
            backend_used = "openai-compat"
            return result
        result = _summarize_anthropic(cfg, user_content)
        backend_used = "anthropic"
        return result
    except Exception:
        result = dict(FALLBACK)
        backend_used = "fallback"
        return result
    finally:
        _track_backend(backend_used)
        _debug_log(
            {
                "mode": "single",
                "turn_id": t.id,
                "backend": backend_used,
                "input": user_content,
                "output": result,
            }
        )


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


def _summarize_openai_compat(cfg, user_content: str, *, model: str | None = None) -> dict:
    """OpenAI-compat fallback path (uses fallback_model if configured)."""
    model = model or cfg.summarizer_fallback_model or cfg.summarizer_model
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


def summarize_batch(
    turns: list,
    *,
    backend: str | None = None,
    model_override: str | None = None,
) -> list[TurnSummary]:
    """Summarize multiple turns in a single LLM call.

    Returns a list of TurnSummary in the same order as the input turns.
    Falls back to sequential single-turn calls if batch parsing fails.

    If backend is set, dispatch via registry (preferred first, fall through).
    If model_override is set, skips the native Ollama path and goes directly
    to OpenAI-compat with the specified model (used by overflow worker).
    """
    if not turns:
        return []
    cfg = get_config()
    coerced = [_coerce_turn(t) for t in turns]
    user_content = _format_batch(coerced, cfg)
    results = None
    backend_used = "unknown"

    try:
        # Work-stealing dispatch: use registry when backend is specified
        if backend and not model_override:
            for name in _backend_order(backend, _SUMMARIZER_BACKENDS):
                avail_fn, _, batch_fn, label_fn = _SUMMARIZER_BACKENDS[name]
                if not avail_fn(cfg):
                    continue
                try:
                    batch_resp = batch_fn(cfg, user_content)
                    results = _align_results(coerced, batch_resp)
                    backend_used = label_fn(cfg)
                    return results
                except Exception:
                    logger.debug("Backend %s batch failed", name, exc_info=True)
            # All registry backends failed — fall through to sequential
            results = _sequential_fallback(coerced, backend=backend)
            backend_used = "sequential-fallback"
            return results

        # Gemini CLI is primary when configured (skip for overflow workers)
        if _gemini_available(cfg) and not model_override:
            try:
                batch_resp = _batch_gemini(cfg, user_content)
                results = _align_results(coerced, batch_resp)
                backend_used = cfg.summarizer_gemini_model or "gemini"
                return results
            except Exception:
                logger.debug("Gemini CLI batch failed, falling back", exc_info=True)
        # OpenCode CLI is secondary cloud backend (skip for overflow workers)
        if _opencode_available(cfg) and not model_override:
            try:
                batch_resp = _batch_opencode(cfg, user_content)
                results = _align_results(coerced, batch_resp)
                backend_used = cfg.summarizer_opencode_model or "opencode"
                return results
            except Exception:
                logger.debug("OpenCode CLI batch failed, falling back", exc_info=True)
        # Z.ai cloud backend (skip for overflow workers)
        if _zai_available(cfg) and not model_override:
            try:
                batch_resp = _batch_zai(cfg, user_content)
                results = _align_results(coerced, batch_resp)
                backend_used = cfg.descripterizer_zai_model
                return results
            except Exception:
                logger.debug("Z.ai batch failed, falling back", exc_info=True)
        # LM Studio local backend (skip for overflow workers)
        if _lmstudio_available(cfg) and not model_override:
            try:
                batch_resp = _batch_lmstudio(cfg, user_content)
                results = _align_results(coerced, batch_resp)
                backend_used = cfg.summarizer_lmstudio_model or "lmstudio"
                return results
            except Exception:
                logger.debug("LM Studio batch failed, falling back", exc_info=True)
        if cfg.summarizer_base_url:
            if model_override:
                batch_resp = _batch_openai_compat(cfg, user_content, model=model_override)
                backend_used = f"openai-compat/{model_override}"
            else:
                try:
                    batch_resp = _batch_ollama_native(cfg, user_content)
                    results = _align_results(coerced, batch_resp)
                    backend_used = "ollama-native"
                    return results
                except Exception:
                    logger.debug("Native Ollama batch failed, trying OpenAI-compat", exc_info=True)
                batch_resp = _batch_openai_compat(cfg, user_content)
                backend_used = "openai-compat"
        else:
            batch_resp = _batch_anthropic(cfg, user_content)
            backend_used = "anthropic"
        results = _align_results(coerced, batch_resp)
        return results
    except Exception:
        logger.debug("Batch parse failed, falling back to sequential", exc_info=True)
        results = _sequential_fallback(coerced, model_override=model_override)
        backend_used = "sequential-fallback"
        return results
    finally:
        _track_backend(backend_used)
        _debug_log(
            {
                "mode": "batch",
                "turn_ids": [t.id for t in coerced],
                "backend": backend_used,
                "input": user_content,
                "output": [s.model_dump() for s in results] if results else None,
            }
        )


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


def _batch_openai_compat(
    cfg, user_content: str, *, model: str | None = None
) -> BatchSummaryResponse:
    """OpenAI-compat fallback with 3-tier structured output strategy.

    Uses fallback_model if configured (for when primary is a thinking model).
    """
    model = model or cfg.summarizer_fallback_model or cfg.summarizer_model
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


# ---------------------------------------------------------------------------
# Backend registry + dispatch
# ---------------------------------------------------------------------------

_SUMMARIZER_BACKENDS = {
    "gemini": (_gemini_available, _summarize_gemini, _batch_gemini,
               lambda cfg: cfg.summarizer_gemini_model or "gemini"),
    "opencode": (_opencode_available, _summarize_opencode, _batch_opencode,
                 lambda cfg: cfg.summarizer_opencode_model or "opencode"),
    "zai": (_zai_available, _summarize_zai, _batch_zai,
            lambda cfg: cfg.descripterizer_zai_model),
    "lmstudio": (_lmstudio_available, _summarize_lmstudio, _batch_lmstudio,
                 lambda cfg: cfg.summarizer_lmstudio_model or "lmstudio"),
    "ollama": (lambda cfg: bool(cfg.summarizer_base_url),
               _summarize_ollama_native, _batch_ollama_native,
               lambda cfg: "ollama-native"),
    "anthropic": (lambda cfg: True, _summarize_anthropic, _batch_anthropic,
                  lambda cfg: "anthropic"),
}


def _backend_order(preferred: str, all_backends: dict) -> list[str]:
    """Return backend names with preferred first, then remaining in registry order."""
    order = [preferred] if preferred in all_backends else []
    for name in all_backends:
        if name not in order:
            order.append(name)
    return order


def _align_results(
    turns: list[Turn],
    batch_resp: BatchSummaryResponse,
) -> list[TurnSummary]:
    """Match batch summaries to input turns by turn_id, preserving input order."""
    by_id = {item.turn_id: item for item in batch_resp.summaries}
    results: list[TurnSummary] = []
    for t in turns:
        item = by_id.get(t.id)
        if item is not None:
            results.append(
                TurnSummary(
                    title=item.title,
                    summary=item.summary,
                    classification=item.classification,
                    important=item.important,
                    milestone=item.milestone,
                )
            )
        else:
            results.append(TurnSummary(**FALLBACK))
    return results


def _sequential_fallback(
    turns: list[Turn],
    *,
    backend: str | None = None,
    model_override: str | None = None,
) -> list[TurnSummary]:
    """Fall back to one-at-a-time summarization when batch fails."""
    results: list[TurnSummary] = []
    for t in turns:
        raw = summarize_turn(t, backend=backend, model_override=model_override)
        results.append(TurnSummary(**raw))
    return results
