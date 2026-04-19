# byomem — Build Your Own Claude Code Memory

A minimal, self-hosted memory layer for Claude Code.
Implements the **Git Context Controller** methodology from the GCC paper —
file-based memory that persists across sessions, with two access paths.
Sprint 16 begins the actual TypeScript runtime foundation for BYOMem, and the repo-local runtime package now defaults to TS-native:

- **Push** — Stop hook captures sessions automatically after every response
- **Pull** — MCP server lets Claude query memory on demand during a session

**Works across all projects. No external services. No bloat.**

---

## The Problem

Claude Code's effective context window is ~120–200k tokens despite models supporting 1M+.
Agents get "dumber" on long tasks — repeating mistakes, forgetting earlier work.
The built-in `MEMORY.md` remains the compatibility surface for legacy docs and exports, while the TS runtime is now the active package surface.

## The Methodology (Git Context Controller)

From the GCC paper (arXiv:2508.00031): manage agent memory **exactly like git** using
plain markdown files. The agent branches to explore approaches, commits milestones,
and merges learnings back up. Result: **48% resolution on SWE-Bench-Lite** (state of the art).

**Markdown files are the source of truth for the legacy compatibility layer, not the active runtime implementation.**

---

## Local LLM benchmark

See [docs/local-llm-benchmark-report.md](docs/local-llm-benchmark-report.md) for the local Ollama benchmark results and model recommendations for summarization and descripterizer paths.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Claude Code                          │
│                                                             │
│  Every response ends         Mid-session, on demand        │
│         ↓                            ↓                     │
│   [Stop hook]                  [MCP tools]                  │
│         │                  mem_context / mem_search         │
│         │                  mem_show / mem_latest            │
└─────────┼──────────────────────────┼────────────────────────┘
          │  PUSH                    │  PULL
          ↓                          ↓
┌─────────────────────────────────────────────────────────────┐
│                     ~/.byomem/                            │
│                                                             │
│  <project>/                                                 │
│    main.md                  ← global roadmap, key decisions │
│    branches/                                                │
│      <YYYY-MM-DD-slug>/                                     │
│        commit.md            ← milestones (3-block template) │
│        log.md               ← raw OTA trace                 │
│        metadata.md          ← title, status, tags           │
└─────────────────────────────────────────────────────────────┘
          │
          ↓  important items bubble up
┌─────────────────────────────────────────────────────────────┐
│  ~/.claude/projects/<encoded>/memory/MEMORY.md              │
│  (Claude Code auto-loads this every session)                │
└─────────────────────────────────────────────────────────────┘
```

---

## Configuration

Project-level settings live in `~/.byomem/config.yaml`.

Embedding requests can now be tuned with `embeddings.request_timeout`:

```yaml
embeddings:
  model: text-embedding-3-small
  base_url: http://localhost:11434/v1
  request_timeout: 7
```

- `base_url` is optional and is used for Ollama-compatible or other local OpenAI-style endpoints.
- `request_timeout` is optional and is passed through to the OpenAI client when constructing embedding requests.

## File Structure

```
~/.byomem/
  <project-name>/               # one folder per project (e.g. "otp", "byomem")
    main.md                     # global project context, roadmap, key decisions
    branches/
      <branch-name>/            # one branch per work session or topic
        commit.md               # milestones hit (3-block GCC template)
        log.md                  # raw OTA conversation trace
        metadata.md             # title, date, status, tags
      <branch-name>/
        ...
  config.yaml                   # project paths, LLM settings
  hooks/
    stop_hook.py                # Claude Code Stop hook (installed globally)
  core/
    parser.py                   # reads ~/.claude/projects/**/*.jsonl, groups turns
    summarizer.py               # Claude Haiku → title, summary, classification
    branch_manager.py           # create/commit/merge branch files
    memory_writer.py            # updates main.md and project MEMORY.md
  mcp_server.py                 # MCP server — exposes memory tools to Claude
  cli.py                        # byomem CLI commands
```

### Example: OTP project after a few sessions

```
~/.byomem/
  otp/
    main.md
    branches/
      2026-02-19-abc12345/
        commit.md     # [FIX] stop price uses aux_price not stop_price
        log.md        # full raw session transcript
        metadata.md   # type: fix | status: merged | date: 2026-02-19
      2026-02-18-def67890/
        commit.md     # [DECISION] BUY + negative price for IC credit spreads
        log.md
        metadata.md
```

---

## File Formats (from the GCC paper)

### `main.md`
Global project roadmap. Updated by `merge` and when important items bubble up.
```markdown
# <project-name>

## Goals
<high-level project intent>

## Key Decisions & Fixes
- [2026-02-19] [FIX] Stop price uses aux_price field, not stop_price
- [2026-02-18] [DECISION] IC combo orders use BUY + negative limit price

## Active Branches
- 2026-02-19-abc12345 — stop order price fix (merged)
- 2026-02-18-def67890 — combo order research (merged)
```

### `commit.md` (3-block GCC template)
```markdown
## Branch Purpose
<why this branch was created — the goal or question being explored>

## Previous Progress Summary
<what has been done so far in this branch>

## This Commit's Contribution
<what this specific commit achieved — one meaningful milestone>
```

New commits are appended as additional `## This Commit's Contribution` blocks,
with `## Previous Progress Summary` updated to roll up prior commits.

### `log.md`
Raw OTA (Observation-Thought-Action) trace. Append-only. Full fidelity.
```markdown
<!-- last_id: <uuid> -->

---
**[2026-02-19T10:23:11]** User: why is the stop price not updating?

Claude: Looking at the modify-order endpoint... the field is `aux_price` not
`stop_price`. The base layer schema uses `aux_price` for stop modifications.
[tool calls omitted]

---
**[2026-02-19T10:31:45]** User: ok fix it

Claude: Updated `base_layer_client.py` line 247 to use `aux_price`...
```

### `metadata.md`
Quick-lookup summary for scanning branches without reading commit/log.
```markdown
# 2026-02-19-abc12345
date: 2026-02-19
status: active | merged
type: fix | decision | feature | research
tags: stop-orders, base-layer-client
last_updated: 2026-02-19T10:31:45
summary: Investigated stop price modification failure. Root cause: aux_price
field required, not stop_price. Fixed in base_layer_client.py.
```

---

## Four Agent Actions (GCC)

| Action | Trigger | What happens |
|--------|---------|-------------|
| `BRANCH <name>` | New session or shift in direction | Creates branch dir, inits commit.md with Branch Purpose block |
| `COMMIT <summary>` | Meaningful milestone reached | Appends 3-block entry to commit.md, optionally updates main.md |
| `MERGE <branch>` | Branch work complete | Summarizes branch into main.md, marks metadata status: merged |
| `CONTEXT <opts>` | Agent needs history | Progressive retrieval — see MCP tools below |

---

## Progressive Retrieval (The Key Insight)

Agent reads memory in layers — cheapest first, deeper only when needed:

```
CONTEXT (bare)          → main.md snapshot + list of branches     (always cheap)
CONTEXT --branch <name> → metadata.md + last 10 commit entries    (if relevant)
CONTEXT --commit <hash> → full commit.md block                    (if needed)
CONTEXT --log           → last 20 lines of log.md + scroll        (rarely needed)
CONTEXT --metadata <seg>→ specific metadata segment               (targeted lookup)
```

A project with 100 sessions stays fast — the agent only reads deep into branches

[882 more lines in file. Use offset=221 to continue.]
