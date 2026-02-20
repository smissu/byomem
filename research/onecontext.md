# OneContext Research Notes

## TL;DR

There are two unrelated projects called "OneContext." The one relevant here is
**TheAgentContextLab/OneContext** (964 stars as of Feb 2026). The GitHub repo is
a marketing shell — actual code ships as:

- npm: `onecontext-ai` (thin Node.js bootstrap wrapper, 12.6 KB)
- PyPI: `aline-ai` (57K lines of Python across 124 files)

Internal branding is `realign` / `aline`. "OneContext" is the marketing name.
Mandarin Chinese comments in source suggest a Chinese-speaking dev team.
Very new — first released Feb 7, 2026 (~12 days old at time of research).

---

## What It Actually Does

A **local session recording daemon** that:

1. Watches `~/.claude/projects/*/` for new/modified `.jsonl` session files
2. Parses them into "turns" (groups messages by parentUUID chains)
3. Calls Claude or OpenAI API to summarize each turn (title + summary)
4. Stores everything in a local SQLite DB at `~/.aline/db/aline.db`
5. Optionally: Textual TUI to browse history, share sessions via Vercel backend

Installation: registers itself as a **Claude Code lifecycle hook** (Stop hook),
so it fires automatically after each response.

---

## Architecture (Their Implementation)

```
npm install -g onecontext-ai
  → onecontext-ai (Node.js wrapper)
    → checks for uvx, installs if missing
    → runs: uvx --from aline-ai aline-mcp ...
      → Python package (realign module)
```

```
~/.aline/
  db/aline.db        # SQLite (WAL, V20 schema, cross-process lease locks)
  auth.yaml          # Supabase OAuth credentials
  .signals/          # Signal files written by Stop hook
```

**Background daemons (managed via tmux):**
- `watcher` — file system poll loop, detects session file changes
- `worker` — SQLite job queue consumer, calls LLM, writes summaries

**Hooks installed into Claude Code:**
- `Stop` hook → writes signal file → enqueues summarization job
- `UserPromptSubmit` hook → early title generation
- `PermissionRequest` hook → logging

**Sharing (not needed for our use case):**
- AES-encrypted session export
- Upload to `realign-server.vercel.app` (Vercel backend, not open source)
- Auth via Supabase web OAuth flow

---

## Code Size Breakdown

| Component | Files | Lines | Notes |
|-----------|-------|-------|-------|
| Core (CLI, config, auth, watcher, worker) | 29 | ~11,800 | The actual brain |
| CLI subcommands | 16 | ~15,400 | export, import, search, doctor, upgrade |
| Textual TUI dashboard | 43 | ~17,000 | Terminal UI, 43 files — skip this |
| SQLite schema + ORM | 7 | ~6,500 | V20 migrations, lease locks |
| Claude Code hooks | 8 | ~1,900 | Stop/UserPromptSubmit/Permission hooks |
| Triggers / JSONL parsers | 9 | ~1,800 | Claude/Codex/Gemini adapters |
| LLM summarization pipeline | 5 | ~940 | The key value-add |
| **Total** | **124** | **~57,200** | |

**Core loop (what actually matters) ≈ 500–1,000 lines.**
The rest is TUI, sharing, secrets redaction, and multi-agent-tool support.

---

## Their Dependencies

```
typer>=0.9.0          # CLI framework
pyyaml>=6.0           # Config
rich>=13.0.0          # Terminal output
anthropic>=0.18.0     # Claude API (primary LLM)
openai>=1.0.0         # OpenAI API (fallback LLM)
detect-secrets>=1.4.0 # Secret scanning before shares
git-filter-repo>=2.38.0 # Git history (possibly legacy)
cryptography>=41.0.0  # AES encryption for shares
httpx>=0.24.0         # HTTP client for backend API
scikit-learn>=1.3.0   # TF-IDF / search over session history
numpy>=1.24.0         # Supports scikit-learn
textual>=0.50.0       # Terminal UI framework
```

Runtime requirements: Python 3.11+, `tmux`, `uvx`/`uv`

---

## What We DON'T Need (vs. Their Implementation)

| Their Feature | Needed? | Reason |
|---------------|---------|--------|
| Textual TUI (43 files, 17K lines) | No | Overkill for solo use |
| Vercel sharing backend | No | Solo workflow, no sharing needed |
| Supabase OAuth auth | No | No sharing, no auth needed |
| AES encryption | No | No sharing |
| detect-secrets | No | No sharing |
| scikit-learn / numpy | Later | Semantic search is nice-to-have |
| OpenAI fallback | No | Stick with Claude |
| Codex / Gemini adapters | No | Claude Code only |
| Node.js npm wrapper | No | Can install Python directly |
| git-filter-repo | No | Not clear why they even need this |
| tmux dependency | No | Daemon can be simpler |
| Cross-process lease locks | Maybe | Only needed if multiple processes |
| V20 SQLite migrations | No | Start simple, V1 schema |
| 20 migration scripts | No | Start simple |

**Minimal MVP dependencies:**
```
anthropic    # summarization
pyyaml       # config
rich         # hook output (optional)
```

---

## Key Insight: Claude Code Hook System

OneContext's core trick is registering a **Stop hook** in `~/.claude/settings.json`.
Claude Code fires this hook after every response. The hook receives:
- `session_id` — the current session
- `transcript_path` — path to the JSONL session file

This is the mechanism. Everything else is just what you do with that signal.

Claude Code hook docs: https://docs.anthropic.com/en/docs/claude-code/hooks

---

## Session File Format

Claude Code stores sessions as JSONL at:
`~/.claude/projects/<url-encoded-project-path>/<session-uuid>.jsonl`

Each line is a JSON object. Messages are linked by `parentUUID` to form a tree.
Turns = chains of assistant+user message pairs grouped by parentUUID.

The encoded project path uses `-` instead of `/`:
e.g., `/Users/eric/Documents/otp` → `-Users-eric-Documents-otp`

---

## The GCC Paper (arXiv:2508.00031)

**Author:** Junde Wu (University of Oxford)
**Repo:** https://github.com/human-re/GCC (redirects to the Aline MCP tool)

### What the paper actually specifies

**File structure:**
```
.GCC/
  main.md                          # global roadmap: project goals, milestones, to-do list
  branches/<name>/
    commit.md                      # three blocks: Branch Purpose / Previous Progress Summary / This Commit's Contribution
    log.md                         # full OTA (Observation-Thought-Action) trace between commits
    metadata.yaml                  # structured: file structure, env config, dependency graphs, module interfaces
```

**Four commands:**

| Command | Trigger | What happens |
|---------|---------|-------------|
| `BRANCH <name>` | Agent detects meaningful shift in direction | Creates new branch dir, inits commit.md with branch purpose |
| `COMMIT <summary>` | Agent identifies coherent milestone achieved | Appends to commit.md (3-block template), optionally revises main.md |
| `MERGE <branch>` | Branch reaches conclusion | Updates main.md, merges commit.md entries, preserves OTA traceability |
| `CONTEXT <options>` | Agent needs history | Returns memory at varying granularity (see below) |

**CONTEXT command options:**
- `CONTEXT` (bare) → git-status-style snapshot: project purpose + available branches
- `CONTEXT --branch <name>` → branch purpose + last 10 commits (with scroll_up/scroll_down)
- `CONTEXT --commit <hash>` → full commit.md content
- `CONTEXT --log` → last 20 lines of log.md (with scrolling)
- `CONTEXT --metadata <segment>` → specific segment (file_structure, env_config, etc.)

**commit.md template (3 blocks):**
```
## Branch Purpose
<why this branch was created>

## Previous Progress Summary
<what has been done so far in this branch>

## This Commit's Contribution
<what this specific commit achieved>
```

**Triggers are described but NOT hardcoded** — the paper says commands are described
in the system prompt and agents are "encouraged to use them when needed." The paper
notes agents triggered them spontaneously without explicit rules.

**Performance:** 48% resolution on SWE-Bench-Lite (state-of-the-art at time of writing).
Self-replication case study: 40.7% with GCC vs 11.7% without.

### What the paper does NOT include
- The actual system prompt text given to agents (not published)
- Exact file format examples beyond the commit.md 3-block template
- The retrieval algorithm (just describes it conceptually)

---

## Aline MCP Server (the actual tool implementation)

The GCC paper's implementation ships as an **MCP server** that plugs into Claude Code:

```bash
claude mcp add --scope user --transport stdio aline -- npx -y aline-ai@latest
```

**Exposes 5 MCP tools to Claude:**
```
aline_init               # initialize aline for a project
aline_search             # search session history
aline_show               # browse sessions
aline_get_latest_session # get most recent session context
aline_version            # version check
```

**Architecture:** npm wrapper → uvx → Python `aline-ai` package → MCP stdio server

The actual tool implementations are compiled into the Python wheel (not open source).
Storage is SQLite (`~/.aline/db/aline.db`) despite the paper describing .md files.

**Key insight:** The MCP approach means Claude calls retrieval tools **on demand**
during a session, rather than just having things injected at startup via MEMORY.md.
The agent decides when to call `aline_search` based on what it needs.

---

## Risks if Using Their Package

1. **12 days old** — API/behavior likely to change rapidly
2. **Closed backend** — sharing tied to their Vercel server
3. **No source on GitHub** — can't audit or fork the Python code
4. **Rapid internal churn** — V20 DB schema after 12 days suggests instability
5. **Unknown team** — Chinese comments, unclear org structure
