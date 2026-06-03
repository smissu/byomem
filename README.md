# BYOMem

BYOMem means Bring Your Own Memory. It is a TypeScript-native memory, file-search, and graph runtime for agentic coding tools. It gives Codex CLI, Hermes, Pi/Gemini-style extensions, and other MCP clients a shared project memory layer plus fast indexed source lookup and architecture-aware graph context.

The current implementation is canonical in `ts/packages/runtime`.

## What It Provides

- Durable memory records for project decisions, user preferences, fixes, and session rollups.
- Indexed file search over registered projects with BM25, semantic, and hybrid retrieval.
- Optional graph context on file-search hits through `includeGraph: true`.
- Native graph query, explain, path, status, and update tools inspired by Graphify.
- Codex and Hermes reminder hooks that nudge agents to use memory, file search, and graph tools at the right time.
- Session-capture support for compact Codex Stop-hook summaries.
- Split MCP servers so memory, graph, and file-search failures are isolated.

BYOMem is meant to make agents faster and less repetitive: retrieve durable context first, search indexed source before broad grep, and use graph topology when relationships matter.

## Repository Layout

- `ts/packages/runtime/src/` - canonical TypeScript runtime implementation.
- `ts/packages/runtime/src/mcp/` - MCP server entrypoints and tool registration.
- `ts/packages/runtime/tests/` - runtime, CLI, MCP, file-search, graph, and hook regression tests.
- `docs/` - architecture notes, hook references, sprint plans, and operational runbooks.
- `.codex/hooks.json` - repo-local Codex reminders and optional session capture hook.
- `.pi/extensions/byomem/` and `.gemini/skills/byomem-extension/` - reference notes only, not active runtime entrypoints.

Active Pi/Gemini extensions should delegate to the canonical runtime in `ts/packages/runtime/src/pi-extension.ts`. Do not restore a second active project-local BYOMem runtime under `.pi/extensions/` or `.gemini/extensions/`.

## Setup

Install dependencies and build the runtime:

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

Useful focused checks:

```bash
npm test -- ts/packages/runtime/tests/sprint-65-file-search-graph-context.test.ts
npm run build
```

The root package exposes convenience scripts for the runtime and MCP entrypoints:

```bash
npm run byomem:cli -- graph-status --base-dir /path/to/project
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format json
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime
npm run byomem:mcp-memory
npm run byomem:mcp-graph
npm run byomem:mcp-file-search
```

`./queue-watch.sh` is available for queue observation. It defaults `BYOMEM_RUNTIME_BASE_DIR` to `~/.byomem/runtime` and runs the `queue-observe --watch` CLI path.

## MCP Configuration

Use split MCP servers for normal Codex or Hermes operation. Replace `<HOME>` with your home directory, for example `/home/alex`, `/Users/alex`, or the absolute path where you keep this repo.

For Codex, treat setup and removal as paired lifecycle operations. Preview the config and guidance changes first, then apply only after reviewing the JSON report:

```bash
npm run byomem:cli -- connect codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist
npm run byomem:cli -- connect codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist --apply
npm run byomem:cli -- remove codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist
npm run byomem:cli -- remove codex --runtime-entrypoint <HOME>/Documents/byomem/ts/packages/runtime/dist --apply
```

`connect codex` writes only canonical split BYOMem MCP entries and a marked project guidance block. It refuses duplicate, stale, or conflicting BYOMem MCP entries so those can be reviewed manually instead of being silently overwritten.
`remove codex` is the conservative inverse: dry-run first, explicit apply-after-review, and no durable BYOMem data deletion in this sprint. Safe uninstall means integration rollback does not delete durable data, does not kill or terminate live processes, and rejects dangerous flags such as `--delete-data`, `--kill-processes`, and `--force`.

`remove codex` reads global `~/.codex/config.toml` by default, so dry-run output must be reviewed as an all-project Codex config change. `--apply` removes only recognized BYOMem Codex integration artifacts after backing up modified config/integration files, not durable BYOMem data. Recognized removable artifacts are canonical BYOMem MCP config sections, the marked AGENTS guidance block, canonical Codex hook commands, and stale BYOMem-owned runtime-state records.

```toml
[mcp_servers.byomem-memory]
command = "node"
args = ["<HOME>/Documents/byomem/ts/packages/runtime/dist/mcp/memory.js"]

[mcp_servers.byomem-graph]
command = "node"
args = ["<HOME>/Documents/byomem/ts/packages/runtime/dist/mcp/graph.js"]

[mcp_servers.byomem-file-search]
command = "node"
args = ["<HOME>/Documents/byomem/ts/packages/runtime/dist/mcp/file-search.js"]
```

The compatibility all-in-one operations server is still available:

```toml
[mcp_servers.byomem-operations]
command = "node"
args = ["<HOME>/Documents/byomem/ts/packages/runtime/dist/mcp/operations.js"]
```

Prefer the split servers. File search can be memory-heavy, so isolating it keeps memory and graph tools alive if a worker fails. See [docs/byomem-mcp-process-isolation.md](docs/byomem-mcp-process-isolation.md).

Every MCP surface exposes `byomem_runtime_info` for structured runtime verification. Use it for feature detection; it reports runtime version, server domain, and feature flags such as `split-mcp-servers`, `file-search-worker`, `native-source-graph`, and `file-search-include-graph`. For release evidence, repo-local commands are necessary but not sufficient; installed/global verification should include the active Codex-facing MCP tool result, with `byomem_runtime_info.runtime.packageVersion === "0.1.24"` and `byomem_runtime_info.server.version === "0.1.24"` after the active runtime is rebuilt and restarted.

## Runtime Dashboard

`dashboard` is a read-only snapshot command over the existing `status` and `doctor` reports. It is a presentation layer only: it does not watch files, scan files, update graphs, refresh embeddings, run cleanup/stop, or mutate config/runtime data. HTML output can be opened explicitly with `--open` or served explicitly on loopback with `--serve`.

The static HTML dashboard defaults to a dark theme and embeds a CSS-only light theme path. It includes runtime identity, KPI cards, capability banners, first-run guidance, section summaries, inert command cards, and footer links while keeping the page self-contained with no scripts, forms, remote assets, browser storage, or executable controls.

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html --serve --port 0
```

Omitting `--format` defaults to JSON on stdout. HTML output requires an explicit `--output` path whose parent directory already exists, writes a self-contained static file, and prints a JSON write report containing `reportSchemaVersion`, `command`, `format`, `outputPath`, and `bytesWritten`. `dashboard --serve` binds only to `127.0.0.1`, serves the generated HTML snapshot from memory, and prints a JSON serve report containing the loopback `url`, `host`, `port`, and `pid`. Use `--runtime-base-dir` when the dashboard project/profile base and runtime-state base are different. The static Runtime processes panel is read-only and omits raw argv, cwd, and environment values.

## Codex CLI Usage

Typical agent workflow in a BYOMem-enabled project:

1. Retrieve project memory first for durable decisions and prior outcomes.
2. Use `byomem_file_search` for exact passages, source evidence, and semantic matches.
3. Use `includeGraph: true` for code, architecture, debugging, review, or cross-file investigations.
4. Use `byomem_graph_query`, `byomem_graph_explain`, and `byomem_graph_path` when topology or relationships matter.
5. After source changes, refresh the file-search index and graph as appropriate.

Example MCP-style file search:

```json
{
  "query": "how file-search graph context is attached",
  "mode": "hybrid",
  "includeGraph": true,
  "baseDir": "<HOME>/Documents/byomem"
}
```

Equivalent CLI examples:

```bash
npm run byomem:cli -- file-search-scan --base-dir <HOME>/Documents/byomem
npm run byomem:cli -- file-search --base-dir <HOME>/Documents/byomem --query "graph context" --mode hybrid --include-graph
npm run byomem:cli -- file-search-related --base-dir <HOME>/Documents/byomem --file-path README.md --line 1
npm run byomem:cli -- graph-update --base-dir <HOME>/Documents/byomem --graph-mode native-source
npm run byomem:cli -- graph-query --base-dir <HOME>/Documents/byomem --query "file search graph context"
```

## Hermes Usage

Hermes should use the same MCP split-server model and the same source-of-truth distinction:

- BYOMem memory is for durable facts, decisions, preferences, and outcomes.
- BYOMem file search is for exact source passages and semantic evidence.
- BYOMem graph is for architecture, communities, shortest paths, and cross-file relationships.

Hermes hooks are not Codex hooks. Use Hermes `pre_llm_call` for lightweight context reminders and `post_tool_call` only for cheap post-edit nudges. See [docs/hermes-hooks-reference.md](docs/hermes-hooks-reference.md).

Suggested Hermes hook shape:

```yaml
hooks:
  pre_llm_call:
    - command: <HOME>/.hermes/agent-hooks/byomem-hook.py
      timeout: 10

  post_tool_call:
    - matcher: "^(write_file|patch)$"
      command: <HOME>/.hermes/agent-hooks/byomem-hook.py
      timeout: 10

hooks_auto_accept: true
```

Hooks should remind and guide; they should not run expensive scans or graph builds automatically.

## Skills And Reminder Hooks

BYOMem works best when agents are reminded at the start of a turn which context systems are available.

A Codex repo-local `.codex/hooks.json` can provide:

- `UserPromptSubmit` reminder for BYOMem graph tools.
- `UserPromptSubmit` reminder for BYOMem memory lookup and storage.
- `UserPromptSubmit` reminder for BYOMem file search with `includeGraph` guidance.
- `Stop` hook for optional Codex session capture through `codex-session-capture`.

The hook details and safe activation notes are documented in [docs/codex-hooks-reference.md](docs/codex-hooks-reference.md). Session capture should stay project-local and opt-in; it writes compact `byomem-session` rollups and should not persist raw transcripts, tool traces, signatures, encrypted fields, or binary payloads.
Use `byomem remove codex` to roll back the canonical hook commands and the marked AGENTS guidance block when you no longer want the repo-local reminder setup.

Extension Exposure Decision Record: initial decision is `defer`. BYOMem documents explicit CLI usage for advanced operators and should defer menu/help exposure unless implementation records an explicit override, because accidental uninstall discoverability outweighs menu convenience for this release.

Related skills and setup workflows:

- `byomem-project-init` registers a project for file-search and graph indexing.
- `byomem-project-repair` refreshes stale or unexpectedly sparse indexes.
- `codex-mem-init` installs or migrates Codex reminder hooks and BYOMem guidance.
- File-search registration skills teach agents to register projects explicitly instead of inferring scan permission from memory records.

Reminder hooks are intentionally lightweight. They should steer tool choice, not replace explicit scans, graph updates, or human-reviewed memory capture.

## Graphify And Semble Lineage

BYOMem intentionally absorbed useful behavior from earlier tools while avoiding production dependency on separate subprocesses.

Graphify provided the reference behavior for project graph work: query, explain, path, update, graph reports, and communities. BYOMem now stores graph data in its own `byomem-graph.sqlite`, exposes native graph CLI/MCP tools, and supports `native-source` graph updates. Existing `graphify-out/graph.json` imports are supported for migration and parity, but normal graph maintenance should use `byomem_graph_update` or the CLI `graph-update --graph-mode native-source`.

Native graph creation is not a thin Graphify wrapper. The current builder scans TypeScript, JavaScript, and Python source, extracts files, symbols, imports, calls, methods, and inheritance-style relationships, resolves inferred edges where possible, and records native report/community stats. Graph updates also include downgrade protection so a sparse native build does not silently replace a richer graph unless explicitly allowed.

Semble provided the precedent for file scanning, chunking, embedding, and indexed search. BYOMem implements the file-search stack inside the TypeScript runtime with global project-scoped SQLite storage, scanner status, project registry, semantic refresh, hot-index hydration, and MCP worker isolation. Chunking is code-aware through Chonkie and `tree-sitter-wasms` when available, with deterministic line metadata fallback. Search can stay lexical with BM25 or use semantic/hybrid embeddings when available, and `file-search-related` provides Semble-style related chunk lookup by file path and line number.

The main enhancement is that BYOMem can combine both layers. File-search remains the evidence layer and keeps its ranking stable; graph context is opt-in and additive through `includeGraph: true`. When requested, search hits can include nearby graph nodes, import relationships, and bounded topology context without triggering graph updates, rescans, semantic refreshes, or write paths.

## Index Maintenance

For this repo and other BYOMem-registered projects:

```bash
npm run byomem:cli -- file-search-scan --base-dir <PROJECT_ROOT>
npm run byomem:cli -- graph-update --base-dir <PROJECT_ROOT> --graph-mode native-source
```

Use `graphify-out/graph.json` only for one-time migration or repair imports. If graph state looks empty, stale, unexpectedly sparse, or still depends on legacy Graphify exports, use the repair workflow instead of overwriting a richer graph with a weaker one.

Project registration and polling are explicit:

```bash
npm run byomem:cli -- file-search-project-register --base-dir /path/to/project
npm run byomem:cli -- file-search-project-list
npm run byomem:cli -- file-search-polling-enable --base-dir /path/to/project
```

Registration alone does not start polling. Polling must be enabled deliberately.

## Development Notes

- Keep `package.json`, `package-lock.json`, `ts/packages/runtime/package.json`, and `ts/packages/runtime/src/version.ts` aligned when changing the runtime version.
- Keep MCP server version constants derived from `BYOMEM_RUNTIME_VERSION`.
- Keep generated artifacts out of git: `node_modules/`, `dist/`, caches, coverage, SQLite runtime DBs, graphify output, queues, and local extension state are ignored.
- Prefer native BYOMem graph/file-search tools over raw grep for architecture and source-evidence investigations, then use `rg` for narrow exact checks.
- After code changes in this repo, refresh BYOMem file-search and native graph indexes before relying on updated BYOMem results.

## More Documentation

- [docs/byomem-mcp-process-isolation.md](docs/byomem-mcp-process-isolation.md) - split MCP server design and worker controls.
- [docs/codex-hooks-reference.md](docs/codex-hooks-reference.md) - Codex reminder and Stop-hook reference.
- [docs/hermes-hooks-reference.md](docs/hermes-hooks-reference.md) - Hermes hook patterns.
- [docs/sprint-63-graphify-native-parity.md](docs/sprint-63-graphify-native-parity.md) - native graph implementation background.
- [docs/sprint-65-file-search-graph-context.md](docs/sprint-65-file-search-graph-context.md) - opt-in graph context on file-search results.
- [docs/project-semantic-graph.md](docs/project-semantic-graph.md) - historical semantic graph summary.
