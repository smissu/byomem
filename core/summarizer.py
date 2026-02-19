import json

import anthropic

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
    try:
        cfg = get_config()
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=cfg.summarizer_model,
            max_tokens=cfg.summarizer_max_tokens,
            system=SYSTEM,
            messages=[{
                "role": "user",
                "content": f"User: {turn['user'][:1500]}\n\nClaude: {turn['assistant'][:2500]}",
            }],
        )
        return json.loads(resp.content[0].text)
    except Exception:
        return dict(FALLBACK)
