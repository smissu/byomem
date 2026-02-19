"""Sprint 05c: Live testing of Ollama models with structured output.

Tests qwen2.5:3b and qwen2.5:7b against the 3-tier structured output
fallback in summarizer.py. Measures speed, quality, and reliability.

Run: python tests/live/test_ollama_structured.py
"""
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import openai

from core.models import BatchSummaryResponse, TurnSummary

OLLAMA_BASE_URL = "http://localhost:11434/v1"
MODELS = ["qwen3:4b", "qwen3:8b", "qwen2.5:3b", "qwen2.5:7b"]

# --- Test data ---

SINGLE_TURN = (
    "User: why is the stop price not updating when I modify the order?\n\n"
    "Claude: Looking at the modify-order endpoint in the TWS API, the field "
    "is `aux_price` not `stop_price`. The IB API uses `auxPrice` for stop "
    "and trailing stop orders. Change `order.stop_price = new_price` to "
    "`order.auxPrice = new_price` and it should work."
)

BATCH_TURNS = (
    "--- Turn t1 ---\n"
    "User: why is the stop price not updating?\n\n"
    "Claude: The field is aux_price not stop_price in the IB API.\n\n"
    "--- Turn t2 ---\n"
    "User: add a health check endpoint to the MCP server\n\n"
    "Claude: I'll add a mem_health_check tool that validates search index "
    "integrity, checks for orphaned entries, and reports disk usage.\n\n"
    "--- Turn t3 ---\n"
    "User: the search results are returning log.md files, they shouldn't be indexed\n\n"
    "Claude: Found the bug — index_file was being called on all branch files. "
    "Added a guard to only index commit.md and main.md. Removed stale log.md "
    "entries from the FTS5 table."
)

SINGLE_SYSTEM = """You are a coding session analyzer. Summarize this exchange concisely.

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


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = "\n".join(text.splitlines()[1:])
        if text.strip().endswith("```"):
            text = "\n".join(text.strip().splitlines()[:-1])
    return text.strip()


@dataclass
class TestResult:
    model: str
    test_name: str
    tier: str
    success: bool
    elapsed_s: float
    output: dict | list | None = None
    error: str = ""


def test_single_turn(model: str, client: openai.OpenAI) -> TestResult:
    """Test single-turn summarization (plain text parse)."""
    start = time.time()
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=300,
            messages=[
                {"role": "system", "content": SINGLE_SYSTEM},
                {"role": "user", "content": SINGLE_TURN},
            ],
        )
        text = _strip_fences(resp.choices[0].message.content)
        parsed = json.loads(text)
        ts = TurnSummary(**parsed)
        return TestResult(
            model=model, test_name="single_turn", tier="text_parse",
            success=True, elapsed_s=time.time() - start,
            output=ts.model_dump(),
        )
    except Exception as e:
        return TestResult(
            model=model, test_name="single_turn", tier="text_parse",
            success=False, elapsed_s=time.time() - start,
            error=str(e),
        )


def test_batch_tier1(model: str, client: openai.OpenAI) -> TestResult:
    """Tier 1: OpenAI beta.chat.completions.parse with Pydantic model."""
    start = time.time()
    try:
        resp = client.beta.chat.completions.parse(
            model=model,
            max_tokens=600,
            messages=[
                {"role": "system", "content": BATCH_SYSTEM},
                {"role": "user", "content": BATCH_TURNS},
            ],
            response_format=BatchSummaryResponse,
        )
        parsed = resp.choices[0].message.parsed
        if parsed is None:
            return TestResult(
                model=model, test_name="batch_tier1", tier="beta_parse",
                success=False, elapsed_s=time.time() - start,
                error="parsed is None",
            )
        return TestResult(
            model=model, test_name="batch_tier1", tier="beta_parse",
            success=True, elapsed_s=time.time() - start,
            output=[s.model_dump() for s in parsed.summaries],
        )
    except Exception as e:
        return TestResult(
            model=model, test_name="batch_tier1", tier="beta_parse",
            success=False, elapsed_s=time.time() - start,
            error=str(e),
        )


def test_batch_tier2(model: str, client: openai.OpenAI) -> TestResult:
    """Tier 2: Ollama native JSON schema via extra_body format parameter."""
    start = time.time()
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=600,
            messages=[
                {"role": "system", "content": BATCH_SYSTEM},
                {"role": "user", "content": BATCH_TURNS},
            ],
            extra_body={"format": BatchSummaryResponse.model_json_schema()},
        )
        text = _strip_fences(resp.choices[0].message.content)
        parsed = BatchSummaryResponse.model_validate_json(text)
        return TestResult(
            model=model, test_name="batch_tier2", tier="ollama_format",
            success=True, elapsed_s=time.time() - start,
            output=[s.model_dump() for s in parsed.summaries],
        )
    except Exception as e:
        return TestResult(
            model=model, test_name="batch_tier2", tier="ollama_format",
            success=False, elapsed_s=time.time() - start,
            error=str(e),
        )


def test_batch_tier3(model: str, client: openai.OpenAI) -> TestResult:
    """Tier 3: Plain text response, strip fences, Pydantic validation."""
    start = time.time()
    try:
        resp = client.chat.completions.create(
            model=model,
            max_tokens=600,
            messages=[
                {"role": "system", "content": BATCH_SYSTEM},
                {"role": "user", "content": BATCH_TURNS},
            ],
        )
        text = _strip_fences(resp.choices[0].message.content)
        parsed = BatchSummaryResponse.model_validate_json(text)
        return TestResult(
            model=model, test_name="batch_tier3", tier="text_parse",
            success=True, elapsed_s=time.time() - start,
            output=[s.model_dump() for s in parsed.summaries],
        )
    except Exception as e:
        return TestResult(
            model=model, test_name="batch_tier3", tier="text_parse",
            success=False, elapsed_s=time.time() - start,
            error=str(e),
        )


def run_all():
    client = openai.OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")

    # Warm up: ensure the model is loaded
    tests = [test_single_turn, test_batch_tier1, test_batch_tier2, test_batch_tier3]
    all_results: list[TestResult] = []

    for model in MODELS:
        print(f"\n{'='*60}")
        print(f"  Model: {model}")
        print(f"{'='*60}")

        # Warmup call
        print(f"  Warming up {model}...")
        try:
            client.chat.completions.create(
                model=model, max_tokens=10,
                messages=[{"role": "user", "content": "hi"}],
            )
        except Exception as e:
            print(f"  WARMUP FAILED: {e}")
            print(f"  Skipping {model}")
            continue

        for test_fn in tests:
            result = test_fn(model, client)
            all_results.append(result)

            status = "PASS" if result.success else "FAIL"
            print(f"\n  [{status}] {result.test_name} ({result.tier}) — {result.elapsed_s:.2f}s")
            if result.success and result.output:
                print(f"    Output: {json.dumps(result.output, indent=2)[:500]}")
            if result.error:
                print(f"    Error: {result.error[:300]}")

    # Summary table
    print(f"\n\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    print(f"  {'Model':<15} {'Test':<15} {'Tier':<15} {'Status':<6} {'Time':>6}")
    print(f"  {'-'*15} {'-'*15} {'-'*15} {'-'*6} {'-'*6}")
    for r in all_results:
        status = "PASS" if r.success else "FAIL"
        print(f"  {r.model:<15} {r.test_name:<15} {r.tier:<15} {status:<6} {r.elapsed_s:>5.2f}s")

    # Check if any batch test returned all 3 turn_ids
    print("\n  Turn ID coverage (batch tests):")
    for r in all_results:
        if r.success and r.output and isinstance(r.output, list):
            turn_ids = {s.get("turn_id") for s in r.output if isinstance(s, dict)}
            expected = {"t1", "t2", "t3"}
            coverage = turn_ids & expected
            print(f"  {r.model:<15} {r.test_name:<15} -> {coverage} ({'COMPLETE' if coverage == expected else 'MISSING: ' + str(expected - coverage)})")


if __name__ == "__main__":
    run_all()
