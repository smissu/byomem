# byomem — Build Your Own Claude Code Memory

A minimal, self-hosted memory layer for Claude Code.
Implements the **Git Context Controller** methodology from the GCC paper —
file-based memory that persists across sessions, with two access paths.
Sprint 16 begins the actual TypeScript runtime foundation for BYOMem, while Python remains the current default runtime for now:

- **Push** — Stop hook captures sessions automatically after every response
- **Pull** — MCP server lets Claude query memory on demand during a session

**Works across all projects. No external services. No bloat.**

---

## The Problem

Claude Code's effective context window is ~120–200k tokens despite models supporting 1M+.
Agents get "dumber" on long tasks — repeating mistakes, forgetting earlier work.
The built-in `MEMORY.md` remains the current compatibility surface: manual, flat, Claude-specific, and limited. Sprint 16 is laying the TypeScript foundation for the future native-store path without changing the current Python-default runtime.

## The Methodology (Git Context Controller)

From the GCC paper (arXiv:2508.00031): manage agent memory **exactly like git** using
plain markdown files. The agent branches to explore approaches, commits milestones,
and merges learnings back up. Result: **48% resolution on SWE-Bench-Lite** (state of the art).

**Markdown files are the source of truth. No database required.**

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
that are relevant to the current task.

---

## Push: Stop Hook

Fires after every Claude response. Captures the session automatically.

### Installation (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.byomem/.venv/bin/python ~/.byomem/hooks/stop_hook.py"
          }
        ]
      }
    ]
  }
}
```

### What Claude Code sends (stdin JSON)

```json
{
  "session_id": "abc-123",
  "transcript_path": "/Users/eric/.claude/projects/-Users-eric-Documents-otp/abc-123.jsonl",
  "cwd": "/Users/eric/Documents/otp"
}
```

### Core Loop

```
[Stop hook fires]
        ↓
[Parse JSONL → new turns since last_id in log.md]
        ↓
[For each turn:]
  → append to log.md (raw, always)
  → call Claude Haiku → title, summary, classification, milestone?
  → if milestone → append commit block to commit.md
  → update metadata.md
        ↓
[If fix|decision → bubble up to main.md + project MEMORY.md]
```

### Sketch (`hooks/stop_hook.py`)

```python
#!/usr/bin/env python3
import sys, json
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".byomem"))

from core.parser import parse_new_turns
from core.summarizer import summarize_turn
from core.branch_manager import get_or_create_branch, append_to_log, commit_milestone, update_metadata
from core.memory_writer import maybe_update_main, maybe_update_project_memory

def main():
    data         = json.loads(sys.stdin.read())
    session_id   = data["session_id"]
    transcript   = Path(data["transcript_path"])
    cwd          = data.get("cwd", "")

    if not transcript.exists():
        return

    project = Path(cwd).name
    branch  = get_or_create_branch(project, session_id)

    new_turns = parse_new_turns(transcript, branch.last_turn_id)
    if not new_turns:
        return

    for turn in new_turns:
        append_to_log(branch, turn)
        summary = summarize_turn(turn)
        if summary["milestone"]:
            commit_milestone(branch, summary)
        if summary["important"]:
            maybe_update_main(project, summary)
            maybe_update_project_memory(cwd, summary)

    update_metadata(branch, new_turns[-1])

    # Update search index for changed files (hash-based, skips unchanged)
    from core.search_index import index_file
    for f in (branch.commit_md, BYOMEM / project / "main.md"):
        if f.exists():
            index_file(f, project)

if __name__ == "__main__":
    main()
```

---

## Pull: MCP Server

Exposes memory tools Claude can call **on demand** during a session.
This is how the agent actively retrieves context rather than just receiving
whatever was injected at startup.

### Registration (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "byomem": {
      "command": "/Users/eric/.byomem/.venv/bin/python",
      "args": ["/Users/eric/.byomem/mcp_server.py"]
    }
  },
  "hooks": { ... }
}
```

### Tools Exposed

| Tool | Args | Returns |
|------|------|---------|
| `mem_context` | `project`, `branch?`, `commit?`, `log_lines?` | Progressive context — bare=main.md snapshot, with args=drill down |
| `mem_search` | `query`, `project?`, `max_results?`, `min_score?` | Hybrid FTS5+vector search with weighted fusion; ranked list with scores, file paths, line ranges, 700-char previews |
| `mem_get` | `path`, `start_line`, `line_count?` | Fetch exact lines from a memory file — follow-up to mem_search |
| `mem_show` | `project` | List all branches with metadata summary (title, date, status, type) |
| `mem_latest` | `project` | Most recent branch's commit.md — useful at session start |

### Two-Step Search Pattern

`mem_search` returns scored snippets with line numbers. Claude then calls `mem_get`
to fetch only the specific lines it needs. Context window stays lean.

```
Claude: "what did we decide about stop price modification?"
  → mem_search("stop price modification", project="otp")

## Search: "stop price modification"
3 results (min score 0.35)

─────────────────────────────────────────
[1] score: 0.89 | otp › 2026-02-19-abc12345/commit.md (lines 12–18)
Fixed stop price modification: field is `aux_price` not `stop_price` on
PUT /tws/modify-order. base_layer_client.py line 247 updated accordingly.

[2] score: 0.72 | otp › main.md (lines 8–10)
Stop price uses aux_price field (NOT stop_price) on PUT /tws/modify-order/{id}.

[3] score: 0.61 | otp › 2026-02-18-def67890/commit.md (lines 3–7)
Investigated stop order flow. aux_price is the correct field per IB TWS schema.
─────────────────────────────────────────
Use mem_get(path, start_line, count) to read full content.

  → mem_get("otp/branches/2026-02-19-abc12345/commit.md", 12, 6)
  → returns exact lines 12–18
```

### Sketch (`mcp_server.py`)

```python
#!/usr/bin/env python3
"""
byomem MCP server — exposes memory tools to Claude Code.
Uses the mcp Python package (FastMCP).
"""
from pathlib import Path
from mcp.server.fastmcp import FastMCP

BYOMEM = Path.home() / ".byomem"
mcp = FastMCP("byomem")


@mcp.tool()
def mem_context(project: str, branch: str = "", commit: str = "", log_lines: int = 0) -> str:
    """
    Retrieve project memory at varying granularity (mirrors GCC CONTEXT command).
    - bare (no args): main.md snapshot + list of branches
    - branch=<name>: branch metadata + last 10 commit entries
    - commit=<name>: full commit.md content
    - log_lines=N: last N lines of log.md for the branch
    """
    base = BYOMEM / project

    if not base.exists():
        return f"No memory found for project '{project}'. Run mem_init first."

    # Bare call — git status style snapshot
    if not branch:
        main = (base / "main.md").read_text() if (base / "main.md").exists() else "(empty)"
        branches = sorted((base / "branches").iterdir()) if (base / "branches").exists() else []
        branch_list = "\n".join(
            f"  - {b.name}: {_read_meta_summary(b)}" for b in branches
        ) or "  (none)"
        return f"## {project} — Memory Snapshot\n\n{main}\n\n## Branches\n{branch_list}"

    branch_path = base / "branches" / branch
    if not branch_path.exists():
        return f"Branch '{branch}' not found."

    # Log lines requested
    if log_lines:
        log = (branch_path / "log.md").read_text() if (branch_path / "log.md").exists() else ""
        lines = log.splitlines()
        return "\n".join(lines[-log_lines:])

    # Specific commit block
    if commit:
        commit_md = (branch_path / "commit.md").read_text() if (branch_path / "commit.md").exists() else ""
        return commit_md

    # Branch summary — metadata + last 10 commit lines
    meta    = (branch_path / "metadata.md").read_text() if (branch_path / "metadata.md").exists() else ""
    commits = (branch_path / "commit.md").read_text()   if (branch_path / "commit.md").exists()  else ""
    last_10 = "\n".join(commits.splitlines()[-10:])
    return f"{meta}\n\n## Recent Commits\n{last_10}"


@mcp.tool()
def mem_search(query: str, project: str = "", max_results: int = 6, min_score: float = 0.35) -> str:
    """
    Hybrid search: BM25 keyword (FTS5) + vector (sqlite-vec) with weighted fusion.
    Returns a ranked list of scored snippets with file paths and line ranges.
    Follow up with mem_get() to read specific lines.
    """
    from core.search_index import hybrid_search
    results = hybrid_search(query, project=project, max_results=max_results, min_score=min_score)

    if not results:
        return f"No results for '{query}' (min score {min_score})."

    lines = [f"## Search: \"{query}\"\n{len(results)} results (min score {min_score})\n"]
    for i, r in enumerate(results, 1):
        lines.append("─" * 41)
        lines.append(f"[{i}] score: {r['score']:.2f} | {r['path']} (lines {r['start_line']}–{r['end_line']})")
        lines.append(r['preview'])
    lines.append("─" * 41)
    lines.append("Use mem_get(path, start_line, count) to read full content.")

    return "\n".join(lines)


@mcp.tool()
def mem_get(path: str, start_line: int, line_count: int = 20) -> str:
    """
    Read specific lines from a memory file.
    Use after mem_search to fetch only the relevant content.
    path: relative to ~/.byomem/ (e.g. "otp/branches/2026-02-19-abc12345/commit.md")
    """
    full_path = BYOMEM / path
    if not full_path.exists():
        return f"File not found: {path}"

    all_lines = full_path.read_text().splitlines()
    # 1-based line numbers
    start = max(0, start_line - 1)
    end   = min(len(all_lines), start + line_count)
    excerpt = "\n".join(all_lines[start:end])
    return f"## {path} (lines {start_line}–{end})\n\n{excerpt}"


@mcp.tool()
def mem_show(project: str) -> str:
    """List all branches for a project with metadata summaries."""
    base = BYOMEM / project / "branches"
    if not base.exists():
        return f"No branches found for project '{project}'."

    lines = []
    for branch in sorted(base.iterdir(), reverse=True):
        meta = _read_meta_summary(branch)
        lines.append(f"- **{branch.name}**: {meta}")

    return f"## {project} branches\n\n" + "\n".join(lines)


@mcp.tool()
def mem_latest(project: str) -> str:
    """Return the most recent branch's commit.md — useful at session start."""
    base = BYOMEM / project / "branches"
    if not base.exists():
        return f"No memory for project '{project}'."

    branches = sorted(base.iterdir(), key=lambda b: b.stat().st_mtime, reverse=True)
    if not branches:
        return "No branches found."

    latest = branches[0]
    commit = (latest / "commit.md").read_text() if (latest / "commit.md").exists() else "(empty)"
    return f"## Latest branch: {latest.name}\n\n{commit}"


def _read_meta_summary(branch_path: Path) -> str:
    meta_file = branch_path / "metadata.md"
    if not meta_file.exists():
        return "(no metadata)"
    for line in meta_file.read_text().splitlines():
        if line.startswith("summary:"):
            return line[len("summary:"):].strip()
    return "(no summary)"


if __name__ == "__main__":
    mcp.run()
```

---

## Search Index (`core/search_index.py`)

SQLite database with two virtual tables — FTS5 for BM25 keyword ranking,
sqlite-vec for cosine similarity vector search. Weighted fusion combines both.

### Schema

```sql
-- Tracks indexed files for incremental sync
CREATE TABLE files (
    path         TEXT PRIMARY KEY,
    content_hash TEXT,
    modified_at  REAL
);

-- Chunks: ~400 tokens, 80-token overlap
CREATE TABLE chunks (
    id         INTEGER PRIMARY KEY,
    file_path  TEXT,
    start_line INTEGER,
    end_line   INTEGER,
    text       TEXT
);

-- BM25 full-text search (FTS5)
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);

-- Vector search (sqlite-vec)
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding FLOAT[1536]);

-- Embedding cache — skip re-embedding unchanged chunks
CREATE TABLE embedding_cache (
    text_hash TEXT PRIMARY KEY,
    embedding BLOB   -- float32 array
);
```

### How Hybrid Search Works

```
query: "stop price modification"
        ↓
[embed query]  ←── same provider used at index time
        ↓
[run in parallel]
  ├── FTS5 BM25 search → raw ranks → normalize to 0–1: 1 / (1 + rank)
  └── vec cosine search → cosine distance → similarity: 1 - distance
        ↓
[candidate multiplier: 4× — ask for 6 results, search returns 24 each]
        ↓
[weighted fusion]
  final_score = 0.7 × vector_score + 0.3 × keyword_score
  (results only in one search get 0.0 for the other)
        ↓
[filter: score ≥ 0.35, sort desc, cap at max_results]
        ↓
[return: path, start_line, end_line, score, 700-char preview]
```

### Sketch (`core/search_index.py`)

```python
"""
Hybrid search index: SQLite FTS5 (BM25) + sqlite-vec (cosine).
Weighted fusion: 0.7 * vector + 0.3 * keyword.
"""
import sqlite3
import hashlib
import os
from pathlib import Path

import sqlite_vec                          # pip install sqlite-vec
import anthropic

BYOMEM  = Path.home() / ".byomem"
DB_PATH   = BYOMEM / "search.db"
CHUNK_TOKENS  = 400
CHUNK_OVERLAP = 80
EMBED_DIM     = 1536                       # text-embedding-3-small / voyage-3-large
VECTOR_WEIGHT = 0.7
KEYWORD_WEIGHT = 0.3
CANDIDATE_MULT = 4


def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    _init_schema(db)
    return db


def index_file(path: Path, project: str):
    """Chunk a .md file and upsert into the search index. Skip if unchanged."""
    db       = get_db()
    rel_path = str(path.relative_to(BYOMEM))
    content  = path.read_text()
    h        = hashlib.sha256(content.encode()).hexdigest()

    row = db.execute("SELECT content_hash FROM files WHERE path=?", (rel_path,)).fetchone()
    if row and row[0] == h:
        return  # unchanged — skip

    # Remove old chunks
    db.execute("DELETE FROM chunks WHERE file_path=?", (rel_path,))

    # Chunk the content
    chunks = _chunk_text(content, CHUNK_TOKENS, CHUNK_OVERLAP)

    for start_line, end_line, text in chunks:
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        embedding = _get_embedding(db, text, text_hash)

        cur = db.execute(
            "INSERT INTO chunks (file_path, start_line, end_line, text) VALUES (?,?,?,?)",
            (rel_path, start_line, end_line, text)
        )
        chunk_id = cur.lastrowid
        db.execute(
            "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
            (chunk_id, sqlite_vec.serialize_float32(embedding))
        )

    db.execute(
        "INSERT OR REPLACE INTO files (path, content_hash, modified_at) VALUES (?,?,?)",
        (rel_path, h, path.stat().st_mtime)
    )
    db.commit()


def hybrid_search(query: str, project: str = "", max_results: int = 6,
                  min_score: float = 0.35) -> list[dict]:
    db         = get_db()
    candidates = max_results * CANDIDATE_MULT

    # Embed the query
    q_hash     = hashlib.sha256(query.encode()).hexdigest()
    q_embedding = _get_embedding(db, query, q_hash)

    # Scope to project if given
    path_filter = f"{project}/%" if project else "%"

    # --- Vector search ---
    vec_rows = db.execute("""
        SELECT c.id, c.file_path, c.start_line, c.end_line, c.text,
               vec_distance_cosine(cv.embedding, ?) AS distance
        FROM chunks_vec cv
        JOIN chunks c ON c.id = cv.rowid
        WHERE c.file_path LIKE ?
        ORDER BY distance ASC
        LIMIT ?
    """, (sqlite_vec.serialize_float32(q_embedding), path_filter, candidates)).fetchall()

    # Cosine distance → similarity score
    vec_scores = {
        row[0]: {"path": row[1], "start_line": row[2], "end_line": row[3],
                 "text": row[4], "vec_score": 1.0 - row[5]}
        for row in vec_rows
    }

    # --- Keyword search (BM25) ---
    fts_rows = db.execute("""
        SELECT c.id, c.file_path, c.start_line, c.end_line, c.text,
               rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? AND c.file_path LIKE ?
        ORDER BY rank
        LIMIT ?
    """, (query, path_filter, candidates)).fetchall()

    # BM25 rank (negative) → normalized 0–1 score: 1 / (1 + |rank|)
    kw_scores = {
        row[0]: {"path": row[1], "start_line": row[2], "end_line": row[3],
                 "text": row[4], "kw_score": 1.0 / (1.0 + abs(row[5]))}
        for row in fts_rows
    }

    # --- Weighted fusion ---
    all_ids = set(vec_scores) | set(kw_scores)
    results = []
    for chunk_id in all_ids:
        v = vec_scores.get(chunk_id, {})
        k = kw_scores.get(chunk_id, {})
        info = v or k
        score = (VECTOR_WEIGHT  * v.get("vec_score", 0.0) +
                 KEYWORD_WEIGHT * k.get("kw_score",  0.0))

        if score < min_score:
            continue

        results.append({
            "score":      round(score, 4),
            "path":       info["path"],
            "start_line": info["start_line"],
            "end_line":   info["end_line"],
            "preview":    info["text"][:700],
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:max_results]


def _get_embedding(db: sqlite3.Connection, text: str, text_hash: str) -> list[float]:
    """Return cached embedding or generate a new one."""
    row = db.execute(
        "SELECT embedding FROM embedding_cache WHERE text_hash=?", (text_hash,)
    ).fetchone()
    if row:
        return sqlite_vec.deserialize_float32(row[0])

    # Generate via OpenAI (swap for Voyage/local as needed)
    import openai
    resp = openai.OpenAI().embeddings.create(
        model="text-embedding-3-small", input=text
    )
    embedding = resp.data[0].embedding
    db.execute(
        "INSERT INTO embedding_cache (text_hash, embedding) VALUES (?,?)",
        (text_hash, sqlite_vec.serialize_float32(embedding))
    )
    return embedding


def _chunk_text(text: str, chunk_tokens: int, overlap_tokens: int) -> list[tuple]:
    """Split text into (start_line, end_line, chunk_text) tuples."""
    lines   = text.splitlines()
    chunks  = []
    i       = 0
    approx_chars_per_token = 4

    chunk_chars   = chunk_tokens   * approx_chars_per_token
    overlap_chars = overlap_tokens * approx_chars_per_token

    while i < len(lines):
        chunk_lines = []
        char_count  = 0
        j = i
        while j < len(lines) and char_count < chunk_chars:
            chunk_lines.append(lines[j])
            char_count += len(lines[j])
            j += 1

        if chunk_lines:
            chunks.append((i + 1, j, "\n".join(chunk_lines)))

        # Advance with overlap
        overlap_so_far = 0
        while j > i and overlap_so_far < overlap_chars:
            j -= 1
            overlap_so_far += len(lines[j])
        i = max(i + 1, j)

    return chunks


def _init_schema(db: sqlite3.Connection):
    db.executescript(f"""
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, content_hash TEXT, modified_at REAL
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY, file_path TEXT,
            start_line INTEGER, end_line INTEGER, text TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(text, content=chunks, content_rowid=id);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec
            USING vec0(embedding FLOAT[{EMBED_DIM}]);
        CREATE TABLE IF NOT EXISTS embedding_cache (
            text_hash TEXT PRIMARY KEY, embedding BLOB
        );
    """)
    db.commit()
```

### Incremental Sync

The stop hook calls `index_file()` after writing to `commit.md` and `main.md`.
Only changed files (hash mismatch) get rechunked and re-embedded.
`log.md` is **not indexed** — it's raw detail, retrieved directly via `mem_get`.

---

## Supporting Core Files

### `core/branch_manager.py`

```python
import re
from pathlib import Path
from datetime import date
from dataclasses import dataclass

BYOMEM = Path.home() / ".byomem"

@dataclass
class Branch:
    path: Path
    last_turn_id: str | None

    @property
    def commit_md(self): return self.path / "commit.md"
    @property
    def log_md(self):    return self.path / "log.md"
    @property
    def meta_md(self):   return self.path / "metadata.md"


def get_or_create_branch(project: str, session_id: str) -> Branch:
    slug = session_id[:8]
    name = f"{date.today()}-{slug}"
    path = BYOMEM / project / "branches" / name
    path.mkdir(parents=True, exist_ok=True)

    for f in (path / "commit.md", path / "log.md"):
        if not f.exists():
            f.write_text("")

    if not (path / "metadata.md").exists():
        (path / "metadata.md").write_text(
            f"# {name}\ndate: {date.today()}\nstatus: active\ntype:\ntags:\nsummary:\n"
        )

    return Branch(path=path, last_turn_id=_last_turn_id(path / "log.md"))


def append_to_log(branch: Branch, turn: dict):
    entry = (
        f"\n<!-- last_id: {turn['id']} -->\n"
        f"---\n**[{turn['timestamp']}]** {turn['user'][:300]}\n\n"
        f"{turn['assistant'][:600]}\n"
    )
    with branch.log_md.open("a") as f:
        f.write(entry)


def commit_milestone(branch: Branch, summary: dict):
    """Append a new commit block using the GCC 3-block template."""
    existing = branch.commit_md.read_text() if branch.commit_md.exists() else ""

    # Roll previous "This Commit" sections into Previous Progress
    new_content = existing + f"""
## This Commit's Contribution
**[{summary['classification'].upper()}] {summary['title']}**
{summary['summary']}
"""
    branch.commit_md.write_text(new_content)


def update_metadata(branch: Branch, last_turn: dict):
    meta = branch.meta_md.read_text()
    meta = re.sub(r"last_updated:.*\n", "", meta)
    meta += f"last_updated: {last_turn['timestamp']}\n"
    branch.meta_md.write_text(meta)


def _last_turn_id(log_path: Path) -> str | None:
    if not log_path.exists() or not log_path.stat().st_size:
        return None
    for line in reversed(log_path.read_text().splitlines()):
        if "<!-- last_id:" in line:
            return line.split("last_id:")[1].strip().rstrip(" -->")
    return None
```

### `core/summarizer.py`

```python
import os, json
import anthropic

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

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

def summarize_turn(turn: dict) -> dict:
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        system=SYSTEM,
        messages=[{"role": "user", "content":
            f"User: {turn['user'][:1500]}\n\nClaude: {turn['assistant'][:2500]}"}]
    )
    try:
        return json.loads(resp.content[0].text)
    except Exception:
        return {"title": "Session turn", "summary": "", "classification": "general",
                "important": False, "milestone": False}
```

### `core/parser.py`

```python
import json
from pathlib import Path

def parse_new_turns(transcript: Path, since_id: str | None = None) -> list[dict]:
    lines    = transcript.read_text().strip().splitlines()
    messages = [json.loads(l) for l in lines if l.strip()]
    turns, processed, found_since = [], set(), since_id is None

    for msg in messages:
        if msg.get("type") != "user" or msg.get("uuid") in processed:
            continue
        if not found_since:
            if msg.get("uuid") == since_id:
                found_since = True
            continue

        assistant_msgs = [
            m for m in messages
            if m.get("parentUUID") == msg["uuid"] and m.get("type") == "assistant"
        ]
        processed.update(m["uuid"] for m in assistant_msgs)
        processed.add(msg["uuid"])

        turns.append({
            "id":        msg["uuid"],
            "timestamp": msg.get("timestamp", ""),
            "user":      _text(msg)[:2000],
            "assistant": " ".join(_text(m) for m in assistant_msgs)[:3000],
        })

    return turns

def _text(msg: dict) -> str:
    content = msg.get("message", {}).get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""
```

### `core/memory_writer.py`

```python
from pathlib import Path
from datetime import date

BYOMEM = Path.home() / ".byomem"

def maybe_update_main(project: str, summary: dict):
    main = BYOMEM / project / "main.md"
    if not main.exists():
        main.parent.mkdir(parents=True, exist_ok=True)
        main.write_text(f"# {project}\n\n## Key Decisions & Fixes\n")
    content = main.read_text()
    entry = f"- [{date.today()}] [{summary['classification'].upper()}] {summary['title']}: {summary['summary']}\n"
    if "## Key Decisions & Fixes" not in content:
        content += "\n## Key Decisions & Fixes\n"
    main.write_text(content + entry)

def maybe_update_project_memory(cwd: str, summary: dict):
    path = _cc_memory_path(cwd)
    content = path.read_text() if path.exists() else ""
    entry = f"\n- [{date.today()}] {summary['title']}: {summary['summary']}"
    if "## Auto-captured" not in content:
        content += "\n\n## Auto-captured\n"
    path.write_text(content + entry)

def _cc_memory_path(cwd: str) -> Path:
    encoded  = "-" + cwd.replace("/", "-")
    mem_dir  = Path.home() / ".claude" / "projects" / encoded / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    return mem_dir / "MEMORY.md"
```

---

## CLI Sketch (`cli.py`)

```
byomem install          # register Stop hook + MCP server in ~/.claude/settings.json
byomem status           # hook installed? MCP running? last run per project?
byomem show <project>   # list branches with metadata summaries
byomem log <project> <branch>   # print commit.md for a branch
byomem search <query>   # grep across all commit.md + main.md
byomem merge <project> <branch> # promote branch into main.md
```

---

## What to Build (in order)

### Phase 1 — Capture (Push path, ~1-2 days)
- [ ] `core/parser.py` — JSONL reader, turn grouper, resume from last_id
- [ ] `core/summarizer.py` — Claude Haiku call, JSON output
- [ ] `core/branch_manager.py` — create branch dirs, append log/commit/metadata
- [ ] `core/memory_writer.py` — write to main.md + project MEMORY.md
- [ ] `hooks/stop_hook.py` — orchestrates the push loop
- [ ] Hook registration in `~/.claude/settings.json`
- [ ] Test end-to-end on one real session

### Phase 2 — Retrieval (Pull path, ~1-2 days)
- [ ] Add `mcp`, `sqlite-vec`, `openai` to requirements
- [ ] `core/search_index.py` — FTS5 + sqlite-vec schema, chunking, hybrid search, embedding cache
- [ ] `mcp_server.py` — `mem_context`, `mem_search`, `mem_get`, `mem_show`, `mem_latest`
- [ ] Update stop hook to call `index_file()` after writing commit.md / main.md
- [ ] MCP server registration in `~/.claude/settings.json`
- [ ] Test: ask Claude "what did we decide about X?" → verify ranked results + mem_get follow-up

### Phase 3 — CLI (~1 day)
- [ ] `cli.py` with `install`, `status`, `show`, `log`, `search`, `merge`

### Phase 4 — Nice to have (later)
- [ ] Semantic search (embeddings instead of grep in mem_search)
- [ ] Cross-project pattern detection
- [ ] Weekly digest across all projects

---

## Dependencies

```
# requirements.txt
anthropic    # summarization via Claude Haiku
pyyaml       # config
rich         # hook terminal output
mcp          # MCP server (Phase 2)
sqlite-vec   # vector search extension for SQLite (Phase 2)
openai       # embeddings: text-embedding-3-small (swap for voyage/local as needed)
```

---

## Decisions Made

- **File-first** — markdown is source of truth. Human-readable, grep-able, no migrations.
- **GCC 3-block commit template** — matches the paper exactly (Branch Purpose /
  Previous Progress Summary / This Commit's Contribution).
- **Two access paths** — Stop hook (push, automatic) + MCP server (pull, on-demand).
  This matches how Aline actually works: passive capture + active retrieval.
- **Haiku for summarization** — cheap (~$0.001/session), fast, good enough for JSON.
- **Three write targets** — branch files (full fidelity), main.md (distilled),
  Claude Code MEMORY.md (auto-loaded into every session).
- **No daemon** — Stop hook is synchronous, MCP server is stdio (Claude manages the process).
- **No TUI, no sharing, no Node.js** — solo workflow, local data, plain Python.
- **Branch per session** — automatic, date-stamped. No manual branching needed
  for basic use.

---

## Research

See `research/onecontext.md` for full notes on the OneContext/Aline project,
the GCC paper (arXiv:2508.00031), and what we learned from the source investigation.
