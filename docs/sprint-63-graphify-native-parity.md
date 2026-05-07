# Sprint 63: Graphify-Native BYOMem Graph Search

> Use `sprint-implementation` to execute this plan task-by-task after review.
> This plan is eKanban-ready, but the current Codex session does not expose an eKanban MCP tool.

## Implementation Status

Implemented on branch `sprint63-graph-native` in the isolated worktree `/private/tmp/byomem-sprint63`. Sprint 62 stabilization is complete, and the Sprint 64 Codex Stop-hook follow-up fixed live Codex `response_item.payload` transcript parsing so session-capture rollups no longer checkpoint live turns as `no-pending-turns`. This supersedes the earlier wrapper-style Sprint 63 plan. The objective is native BYOMem graph functionality, not a thin subprocess bridge to the external `graphify` CLI.

Implementation notes:

- Added native graph persistence in `byomem-graph.sqlite`, separate from memory and file-search storage.
- Added BYOMem CLI commands: `graph-status`, `graph-query`, `graph-explain`, `graph-path`, and `graph-update`.
- Added MCP tools: read-only `byomem_graph_status`, `byomem_graph_query`, `byomem_graph_explain`, `byomem_graph_path`, plus operations-only `byomem_graph_update`.
- Read-only graph MCP tools open the graph DB read-only and do not create graph DB files on clean runtimes.
- Graph rows are project-scoped inside the graph DB so updating one project does not wipe another project's graph in the same runtime.
- Existing `graphify-out/graph.json` import is supported for migration/parity, and `native-source` update mode builds a deterministic source graph without shelling out to `graphify`.
- Verification passed in the sprint worktree: focused graph tests, MCP regressions, full `npm test` (99 files / 391 tests), and `npm run build`.

## Objective

Recreate graphify-style project graph functionality inside the TypeScript BYOMem runtime so agents can use one MCP server: BYOMem.

This should follow the Semble precedent from Sprint 54:

- Treat graphify's observable behavior as the target contract.
- Implement a BYOMem-native graph index, graph builder, graph query engine, path search, explain surface, status surface, and update path.
- Use existing `graphify-out/graph.json` and the external `graphify` CLI only as parity/reference inputs during tests and migration.
- Do not require a separate graphify MCP server or production subprocess calls for normal BYOMem graph tools.

## Current State

- The repo has an external graphify graph at `graphify-out/`.
- `graphify-out/GRAPH_REPORT.md` reports 5,209 nodes, 7,286 edges, and 110 communities as of 2026-05-07 after the latest `graphify update .`.
- External graphify provides useful behavior today:
  - `graphify query`
  - `graphify explain`
  - `graphify path`
  - `graphify update`
  - graph report/community output
- BYOMem already has:
  - TS-native memory store and MCP servers
  - TS-native file-search index/search stack
  - file scanner, chunker, line metadata, project identity, MCP operations/readonly surfaces
  - Semble-style recreation precedent in `FileSearchIndex`

## Recent Readiness Updates

- Sprint 62 removed the blocking native-store conflict path for file-search and memory tooling by adding explicit inspect/repair surfaces and repairing the live runtime with SQLite authority.
- Sprint 64 added the `codex-session-capture` CLI Stop-hook adapter and was validated against live Codex transcripts after adding support for `response_item.payload.role` / `payload.content` wrappers.
- `AGENTS.md` now includes memory-hygiene guidance: prune clearly stale or redundant memories proactively, especially ephemeral `byomem-session` rollups superseded by architecture, bugfix, sprint-outcome, or preference records.
- The current BYOMem file-search index is healthy after the latest scan: 280 indexed files, 5,156 chunks, 5,156 embedded chunks, and no missing/incompatible/failed embeddings.
- Implementation should begin from current `graphify-out/graph.json` and `GRAPH_REPORT.md` state, not older Sprint 63 planning counts.

## Success Criteria

- BYOMem exposes native graph tools from its existing MCP servers:
  - readonly: `byomem_graph_status`
  - readonly: `byomem_graph_query`
  - readonly: `byomem_graph_explain`
  - readonly: `byomem_graph_path`
  - operations: `byomem_graph_update`
- BYOMem CLI exposes equivalent native commands:
  - `graph-status`
  - `graph-query`
  - `graph-explain`
  - `graph-path`
  - `graph-update`
- Production BYOMem graph tools do not shell out to `graphify`.
- BYOMem can import existing `graphify-out/graph.json` into a native graph index for migration/parity.
- BYOMem can build/update its own project graph from source files without requiring the external graphify CLI.
- Native query/path/explain outputs are comparable to graphify on this repo for core architecture questions.
- Graph storage is separate from memory records and file-search chunks; graph data must not pollute durable memory search.
- Graph tools use BYOMem project identity/baseDir rules and one-MCP access patterns.
- File-search integration is additive: graph results can link to exact BYOMem file-search passages, but graph ranking must not silently alter default file-search ranking.

## Out Of Scope

- Keeping graphify as a production subprocess dependency.
- Requiring a separate graphify MCP server.
- Full LLM semantic re-extraction parity for every graphify inferred edge in the first implementation slice.
- Image/PDF/non-code graph extraction parity in this sprint.
- Merging graph nodes into BYOMem memory records.
- Automatically running graph update on every file-search scan.

## Architecture

Add native graph modules under `ts/packages/runtime/src/`:

- `graph-index.ts`: in-memory query/path/explain facade over graph rows.
- `graph-db.ts`: SQLite persistence for graph nodes, edges, communities, runs, and source fingerprints.
- `graph-builder.ts`: project scan and deterministic graph extraction.
- `graph-import.ts`: import/parity loader for existing `graphify-out/graph.json`.
- `graph-query.ts`: public query, explain, and path APIs used by CLI/MCP.

Suggested SQLite tables:

- `graph_projects`
- `graph_runs`
- `graph_nodes`
- `graph_edges`
- `graph_communities`
- `graph_source_files`
- `graph_source_symbols`

The graph database should be a BYOMem runtime artifact, for example `byomem-graph.sqlite`, not the memory DB and not the file-search DB.

## Target Contract

Mirror graphify's user-facing behavior, but with BYOMem-native names:

- `status(baseDir?)`
  - reports project key, graph DB path, graph exists, node count, edge count, community count, last update, stale files, and source mode.
- `update(baseDir?, mode?)`
  - scans project files, extracts graph nodes/edges, updates graph DB, recomputes communities, and returns a report.
- `query(question, budget?, traversal?)`
  - returns relevant nodes/edges for architecture and relationship questions using native graph traversal.
- `explain(nodeLabel, budget?)`
  - returns a plain explanation of a node and its neighbors.
- `path(sourceLabel, targetLabel, maxDepth?)`
  - returns shortest path over native graph edges.

## Workstreams

- `contract-tests`: graph API, CLI, MCP, and parity RED tests.
- `graph-schema`: SQLite schema, project identity, graph run metadata, source fingerprints.
- `graph-import`: load existing `graphify-out/graph.json` into native graph DB for migration and parity.
- `graph-builder`: native extraction from source files.
- `graph-query`: BFS/path/explain/query engine.
- `mcp-cli-surfaces`: BYOMem MCP and CLI graph tools.
- `community-report`: community detection and graph status/reporting.
- `file-search-bridge`: optional graph-to-file evidence lookup through BYOMem file search.
- `docs-verification`: docs, parity notes, build/tests, and graph update.

## Phase -1: Freeze Graphify Parity Contract

### Task 63.-1.1: Document The Native Graph Contract

Metadata:

```json
{
  "phase": "-1",
  "task_id": "63.-1.1",
  "category": "contract",
  "workstream": "contract-tests",
  "agent_role": "explorer",
  "reasoning_effort": "medium",
  "owned_paths": [
    "docs/sprint-63-graphify-native-parity.md"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "The sprint explicitly rejects production subprocess wrapping of graphify.",
    "The sprint names BYOMem-native graph modules and persistence.",
    "The sprint defines the native status/update/query/explain/path contract.",
    "External graphify is limited to test/migration parity."
  ]
}
```

### Task 63.-1.2: Capture External Graphify Baseline Fixtures

Metadata:

```json
{
  "phase": "-1",
  "task_id": "63.-1.2",
  "category": "test",
  "workstream": "contract-tests",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/fixtures/sprint-63-graphify-baseline.json",
    "ts/packages/runtime/tests/sprint-63-graph-parity.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Fixture captures representative graphify query/explain/path outputs for this repo.",
    "Fixture includes at least one architecture query, one node explain, and one shortest-path query.",
    "Tests compare native BYOMem graph output shape against the captured baseline without calling graphify during normal test runs."
  ],
  "commands": [
    "graphify query \"How is BYOMem file search implemented?\"",
    "graphify explain \"operations-tools.ts\"",
    "graphify path \"operations-tools.ts\" \"file-search-index.ts\""
  ]
}
```

## Phase 0: RED Tests

### Task 63.0.1: RED Native Graph Schema And Import Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "63.0.1",
  "category": "test",
  "workstream": "graph-schema",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-63-graph-schema.test.ts"
  ],
  "blocked_by": [
    "63.-1.1"
  ],
  "acceptance_criteria": [
    "Opening the native graph DB creates graph tables without touching memory/file-search DB tables.",
    "Importing graphify-out/graph.json persists nodes, edges, communities, source file paths, edge kinds, confidence, and extraction source.",
    "Import is idempotent for the same graph fingerprint.",
    "Graph status reports node/edge/community counts and graph DB path."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-schema.test.ts"
  ]
}
```

### Task 63.0.2: RED Native Query/Explain/Path Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "63.0.2",
  "category": "test",
  "workstream": "graph-query",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-63-graph-query.test.ts"
  ],
  "blocked_by": [
    "63.0.1"
  ],
  "acceptance_criteria": [
    "Native query returns bounded relevant node/edge evidence from the graph DB.",
    "Native explain returns a node, its neighbors, source file references, and edge summaries.",
    "Native path returns deterministic shortest paths with edge kinds and source files.",
    "Invalid or missing node labels return structured not-found diagnostics."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-query.test.ts"
  ]
}
```

### Task 63.0.3: RED Native Graph Builder Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "63.0.3",
  "category": "test",
  "workstream": "graph-builder",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-63-graph-builder.test.ts"
  ],
  "blocked_by": [
    "63.0.1"
  ],
  "acceptance_criteria": [
    "Native graph update scans project files and extracts file/module/function/class nodes.",
    "Native graph update extracts contains/imports_from/calls edges for supported TypeScript files.",
    "No-change update is idempotent and reports zero stale files.",
    "Changed/deleted files update graph rows without leaving stale nodes active."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-builder.test.ts"
  ]
}
```

### Task 63.0.4: RED MCP And CLI Native Graph Surfaces

Metadata:

```json
{
  "phase": "0",
  "task_id": "63.0.4",
  "category": "test",
  "workstream": "mcp-cli-surfaces",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts"
  ],
  "blocked_by": [
    "63.0.2",
    "63.0.3"
  ],
  "acceptance_criteria": [
    "Readonly MCP exposes byomem_graph_status, byomem_graph_query, byomem_graph_explain, and byomem_graph_path.",
    "Operations MCP exposes byomem_graph_update.",
    "CLI exposes graph-status, graph-query, graph-explain, graph-path, and graph-update.",
    "Tests prove these surfaces do not invoke the external graphify executable."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts"
  ]
}
```

### Task 63.0.5: RED Graph/File-Search Evidence Bridge

Metadata:

```json
{
  "phase": "0",
  "task_id": "63.0.5",
  "category": "test",
  "workstream": "file-search-bridge",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-63-graph-file-search-bridge.test.ts"
  ],
  "blocked_by": [
    "63.0.2"
  ],
  "acceptance_criteria": [
    "Graph query results can include source file references that can be followed by BYOMem file search.",
    "Exact source passages are retrieved through BYOMem file search, not duplicated in graph storage.",
    "Default file-search ranking and payloads are unchanged when graph evidence is not requested.",
    "Graph-to-file evidence lookup is bounded and opt-in."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-file-search-bridge.test.ts ts/packages/runtime/tests/sprint-54-file-search-payload-shape.test.ts"
  ]
}
```

## Phase 1: Native Graph Persistence And Import

### Task 63.1.1: Implement Graph SQLite Schema

Metadata:

```json
{
  "phase": "1",
  "task_id": "63.1.1",
  "category": "impl",
  "workstream": "graph-schema",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/graph-db.ts",
    "ts/packages/runtime/tests/sprint-63-graph-schema.test.ts"
  ],
  "blocked_by": [
    "63.0.1"
  ],
  "acceptance_criteria": [
    "Graph DB opens under runtime base dir and is keyed by project identity.",
    "Graph schema records nodes, edges, communities, source files, and graph runs.",
    "Graph rows are isolated from memory records and file-search chunks.",
    "Status reports stable counts and timestamps."
  ]
}
```

### Task 63.1.2: Implement Graphify JSON Importer

Metadata:

```json
{
  "phase": "1",
  "task_id": "63.1.2",
  "category": "impl",
  "workstream": "graph-import",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/graph-import.ts",
    "ts/packages/runtime/src/graph-db.ts",
    "ts/packages/runtime/tests/sprint-63-graph-schema.test.ts",
    "ts/packages/runtime/tests/sprint-63-graph-parity.test.ts"
  ],
  "blocked_by": [
    "63.1.1"
  ],
  "acceptance_criteria": [
    "Importer loads existing graphify-out/graph.json without needing graphify installed.",
    "Importer preserves node labels, source paths, line numbers when available, edge kinds, extraction source, confidence, and community IDs.",
    "Importer tolerates missing optional graphify fields with diagnostics.",
    "Importer is idempotent for unchanged graph content."
  ]
}
```

## Phase 2: Native Graph Query Engine

### Task 63.2.1: Implement GraphIndex Query/Explain/Path

Metadata:

```json
{
  "phase": "2",
  "task_id": "63.2.1",
  "category": "impl",
  "workstream": "graph-query",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/graph-index.ts",
    "ts/packages/runtime/src/graph-query.ts",
    "ts/packages/runtime/tests/sprint-63-graph-query.test.ts",
    "ts/packages/runtime/tests/sprint-63-graph-parity.test.ts"
  ],
  "blocked_by": [
    "63.1.2",
    "63.0.2"
  ],
  "acceptance_criteria": [
    "GraphIndex supports status, query, explain, and path over native graph DB rows.",
    "Path search is deterministic and bounded by maxDepth.",
    "Explain output includes neighbors and source file references.",
    "Query output returns bounded graph evidence and labels enough nodes for follow-up exact search."
  ]
}
```

### Task 63.2.2: Add Community Stats And Report Shape

Metadata:

```json
{
  "phase": "2",
  "task_id": "63.2.2",
  "category": "impl",
  "workstream": "community-report",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/graph-index.ts",
    "ts/packages/runtime/tests/sprint-63-graph-query.test.ts"
  ],
  "blocked_by": [
    "63.2.1"
  ],
  "acceptance_criteria": [
    "Status exposes community count and top connected nodes.",
    "Imported graphify communities are queryable.",
    "Native builder community assignment can start with deterministic connected-component or modularity placeholder if full graphify community parity is deferred.",
    "Any deferred community-parity gap is explicit in status diagnostics."
  ]
}
```

## Phase 3: Native Graph Builder

### Task 63.3.1: Implement Deterministic Source Graph Extraction

Metadata:

```json
{
  "phase": "3",
  "task_id": "63.3.1",
  "category": "impl",
  "workstream": "graph-builder",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/graph-builder.ts",
    "ts/packages/runtime/src/graph-db.ts",
    "ts/packages/runtime/tests/sprint-63-graph-builder.test.ts"
  ],
  "blocked_by": [
    "63.1.1",
    "63.0.3"
  ],
  "acceptance_criteria": [
    "Builder extracts file/module/function/class nodes from TypeScript files.",
    "Builder extracts contains and imports_from edges deterministically.",
    "Builder extracts simple same-file call edges where syntax analysis is available.",
    "Builder records unsupported language diagnostics rather than failing whole-project update."
  ]
}
```

### Task 63.3.2: Implement Native Graph Update Lifecycle

Metadata:

```json
{
  "phase": "3",
  "task_id": "63.3.2",
  "category": "impl",
  "workstream": "graph-builder",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/graph-builder.ts",
    "ts/packages/runtime/src/graph-db.ts",
    "ts/packages/runtime/tests/sprint-63-graph-builder.test.ts"
  ],
  "blocked_by": [
    "63.3.1"
  ],
  "acceptance_criteria": [
    "Graph update detects changed, unchanged, and deleted files by fingerprint.",
    "No-change updates are fast and report zero changed files.",
    "Deleted files deactivate or remove stale graph nodes and edges.",
    "Update reports scanned files, indexed files, node count, edge count, community count, duration, and diagnostics."
  ]
}
```

## Phase 4: BYOMem MCP And CLI Surfaces

### Task 63.4.1: Add Native Graph MCP Tools

Metadata:

```json
{
  "phase": "4",
  "task_id": "63.4.1",
  "category": "impl",
  "workstream": "mcp-cli-surfaces",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/readonly-tools.ts",
    "ts/packages/runtime/src/mcp/operations-tools.ts",
    "ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts"
  ],
  "blocked_by": [
    "63.2.1",
    "63.3.2",
    "63.0.4"
  ],
  "acceptance_criteria": [
    "Readonly MCP exposes native graph status/query/explain/path tools.",
    "Operations MCP exposes native graph update.",
    "MCP graph tools use BYOMem runtime context and project identity.",
    "Tests prove no production MCP graph tool shells out to graphify."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts ts/packages/runtime/tests/sprint-46-mcp-operations.test.ts"
  ]
}
```

### Task 63.4.2: Add Native Graph CLI Commands

Metadata:

```json
{
  "phase": "4",
  "task_id": "63.4.2",
  "category": "impl",
  "workstream": "mcp-cli-surfaces",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts",
    "ts/packages/runtime/tests/cli.test.ts"
  ],
  "blocked_by": [
    "63.2.1",
    "63.3.2",
    "63.0.4"
  ],
  "acceptance_criteria": [
    "CLI exposes graph-status, graph-query, graph-explain, graph-path, and graph-update.",
    "CLI graph commands return JSON using existing CLI error style.",
    "CLI graph commands operate without external graphify installed.",
    "Existing CLI tests remain green."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts ts/packages/runtime/tests/cli.test.ts"
  ]
}
```

## Phase 5: Graph/File-Search Evidence Bridge

### Task 63.5.1: Link Native Graph Results To File-Search Evidence

Metadata:

```json
{
  "phase": "5",
  "task_id": "63.5.1",
  "category": "impl",
  "workstream": "file-search-bridge",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/graph-query.ts",
    "ts/packages/runtime/src/file-search-query.ts",
    "ts/packages/runtime/tests/sprint-63-graph-file-search-bridge.test.ts"
  ],
  "blocked_by": [
    "63.2.1",
    "63.4.1",
    "63.0.5"
  ],
  "acceptance_criteria": [
    "Graph results expose source references that can be followed to exact BYOMem file-search passages.",
    "Exact passages are retrieved from file-search chunks on demand.",
    "Default file-search outputs are unchanged.",
    "Graph evidence lookup is explicit and bounded."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-file-search-bridge.test.ts ts/packages/runtime/tests/sprint-54-file-search-payload-shape.test.ts"
  ]
}
```

## Phase 6: Docs And Verification

### Task 63.6.1: Document One-MCP Native Graph Workflow

Metadata:

```json
{
  "phase": "6",
  "task_id": "63.6.1",
  "category": "docs",
  "workstream": "docs-verification",
  "agent_role": "worker",
  "reasoning_effort": "low",
  "owned_paths": [
    "README.md",
    "docs/README.md",
    "docs/sprint-63-graphify-native-parity.md"
  ],
  "blocked_by": [
    "63.4.1",
    "63.4.2"
  ],
  "acceptance_criteria": [
    "Docs explain BYOMem-native graph tools and one-MCP usage.",
    "Docs state graphify is a reference/parity tool, not a production dependency.",
    "Docs explain when to use graph query/path/explain versus file search.",
    "Docs include migration notes for existing graphify-out imports."
  ]
}
```

### Task 63.6.2: Native Graph Verification Gate

Metadata:

```json
{
  "phase": "6",
  "task_id": "63.6.2",
  "category": "validation",
  "workstream": "docs-verification",
  "agent_role": "default",
  "reasoning_effort": "high",
  "owned_paths": [],
  "blocked_by": [
    "63.1.2",
    "63.2.1",
    "63.3.2",
    "63.4.1",
    "63.4.2",
    "63.5.1",
    "63.6.1"
  ],
  "acceptance_criteria": [
    "Native graph tests pass.",
    "Existing readonly, operations, CLI, and file-search payload tests pass.",
    "npm run build passes.",
    "Native BYOMem graph query/explain/path smoke tests work without calling graphify.",
    "Parity fixture results are close enough to graphify baseline for architecture navigation."
  ],
  "commands": [
    "npm run build",
    "npm test -- ts/packages/runtime/tests/sprint-63-graph-schema.test.ts ts/packages/runtime/tests/sprint-63-graph-query.test.ts ts/packages/runtime/tests/sprint-63-graph-builder.test.ts ts/packages/runtime/tests/sprint-63-graph-mcp-cli.test.ts ts/packages/runtime/tests/sprint-63-graph-file-search-bridge.test.ts ts/packages/runtime/tests/sprint-63-graph-parity.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts ts/packages/runtime/tests/sprint-46-mcp-operations.test.ts ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-54-file-search-payload-shape.test.ts"
  ]
}
```

## Execution Notes

- Sprint 62 is complete and no longer blocks Sprint 63 implementation.
- RED tests and parity fixture capture should use the current `graphify-out/` artifacts and refresh the fixture if `graphify update .` changes the graph during implementation.
- Do not implement production BYOMem graph tools by shelling out to `graphify`.
- Use external graphify only to capture parity fixtures and compare behavior during development.
- Keep graph storage separate from memory and file-search persistence.
- Keep graph-to-file evidence lookup explicit and use BYOMem file search for exact passages.
- After material graph/runtime architecture changes, update durable architecture memories and prune stale session rollups that duplicate the new records.
