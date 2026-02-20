# GCC / OneContext Video Notes

**Source:** https://youtu.be/pAIF7vZm5k0 (Jason, AI Builder Club)
**Topic:** Git Context Controller (GCC) memory framework for coding agents

---

## Problem Statement

- Coding agents get "dumber" on longer, complex tasks due to context window limits
- Effective context window is ~120-200K tokens despite models accepting ~1M
- Claude Code's built-in MEMORY.md is per-project and blows up quickly
- Ideally: memory persists across sessions, agents, and projects

## GCC Architecture (from the paper)

Four files at different levels:

| File | Purpose |
|------|---------|
| `main.md` | Global project context / roadmap |
| `branches/<name>/commit.md` | High-level milestones (like git commits) |
| `branches/<name>/log.md` | Full conversation history (OTA: Observation-Thought-Action) |
| `branches/<name>/metadata.md` | Structured project metadata |

Four agent commands:
- **BRANCH** — triggered when agent explores alternative strategy
- **COMMIT** — triggered when agent hits a milestone or completes a subtask
- **MERGE** — triggered when agent completes a branch's exploration
- **CONTEXT** — progressive retrieval at varying granularity

## How OneContext Implements It

- Installs via `npm i -g onecontext-ai`
- TUI with split view: sessions list on left, agent on right
- **Stop hook** captures conversation after each response
- Watcher service logs sessions into local SQLite DB (`aline.db`)
- Default summarizer: GPT-4 mini
- Cross-session, cross-agent, cross-folder memory sharing

## Key Insight: The Skill File (CLAUDE.md Instruction)

OneContext installs a **skill file** that provides instructions to the agent on how
to use the memory tools. The video shows (paraphrased from transcript):

> "It has this skill file which including context for agent about how to use it
> and it has very specific context here that it will firstly do a broad search
> to search a specific query within that context folder but then they can also
> narrow down scope by passing -s which is a specific session information or a
> specific turn and if they really want it can also dive deeper to do search on
> a specific turn to look into the actual conversation"

The retrieval pattern observed in the demo:
1. Agent **first searches memory** for relevant sessions
2. Reviews session titles/descriptions
3. Narrows down to specific sessions and turns
4. Dives deeper into actual conversation history if needed

## byomem CLAUDE.md Instruction (what we added)

Added to `~/.claude/CLAUDE.md` for global use:

```markdown
## Memory (byomem)

byomem is a persistent memory layer available via MCP. Before answering questions
about past work, decisions, architecture, or project history, search byomem first
using `mem_search(query)` before falling back to grep or file searches. At session
start, call `mem_context(project="<project-name>")` to load project context. Use
`mem_list_projects()` to discover available projects.
```

### Comparison: OneContext vs byomem Instruction

| Aspect | OneContext (skill file) | byomem (CLAUDE.md) |
|--------|----------------------|---------------------|
| Location | Skill file installed by tool | Global `~/.claude/CLAUDE.md` |
| Search pattern | Broad search -> narrow by session -> narrow by turn | `mem_search(query)` -> `mem_get(path, line)` |
| Trigger | Agent decides when to search | "Before answering questions about past work" |
| Scope | Per-context group | Per-project via `mem_context()` |
| Progressive retrieval | Built into search tool flags (-s, turn) | `mem_context` -> `mem_search` -> `mem_get` |

## Performance Claims

- 13-14% better performance on SWE tasks with GCC
- Enables cheaper models (GPT-4.5 Air) to perform at frontier level
- 48% resolution on SWE-Bench-Lite (paper claim)

## Takeaway

The core value is simple: file-system-based memory + agent instructions to search
it first. The actual implementation (SQLite vs files, MCP vs skill commands) matters
less than ensuring the agent knows to **check memory before doing fresh work**.
