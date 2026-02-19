import json

import anthropic
import openai

from core.config import get_config

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

FALLBACK = {
    "title": "Session turn",
    "summary": "",
    "classification": "general",
    "important": False,
    "milestone": False,
}


def summarize_turn(turn: dict) -> dict:
    cfg = get_config()
    user_content = f"User: {turn['user'][:1500]}\n\nClaude: {turn['assistant'][:2500]}"
    try:
        if cfg.summarizer_base_url:
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
    return json.loads(resp.content[0].text)


def _summarize_openai_compat(cfg, user_content: str) -> dict:
    client = openai.OpenAI(base_url=cfg.summarizer_base_url, api_key="ollama")
    resp = client.chat.completions.create(
        model=cfg.summarizer_model,
        max_tokens=cfg.summarizer_max_tokens,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user_content},
        ],
    )
    text = resp.choices[0].message.content
    # Strip markdown fences if present
    if text.strip().startswith("```"):
        text = "\n".join(text.strip().splitlines()[1:])
        if text.strip().endswith("```"):
            text = "\n".join(text.strip().splitlines()[:-1])
    return json.loads(text)
