# Sprint 62: Runtime Stabilization Before New Features

> Use `sprint-implementation` to execute this plan task-by-task after review.
> This plan is eKanban-ready, but the current Codex session does not expose an eKanban MCP tool.

## Implementation Status

Planned. Run this sprint before adding graphify feature surface area, except for any graphify hook/status maintenance needed as a stabilization task.

## Objective

Restore BYOMem runtime reliability before new features. This sprint addresses the highest-value pre-feature list: native-store conflict recovery, file-search regression stabilization, MCP/session timeout cleanup, full-suite OOM handling, and graphify hook visibility.

## Current Evidence

- `npm run build` passed on 2026-05-07.
- `npm test` failed with 81 passed files, 9 failed files, 12 failed tests, then a Node heap OOM.
- `file-search-status` failed through the CLI with `Native store migration conflict: native-store.json differs from SQLite memory records`.
- `graphify hook status` reported post-commit and post-checkout hooks are not installed.
- The worktree already has an unrelated `AGENTS.md` edit. Do not revert it.

## Success Criteria

- Native-store conflict inspection reports JSON-only, SQLite-only, differing, and identical records without mutation.
- Native-store repair is explicit, dry-run capable, backed up, and fail-closed.
- File-search status/search surfaces are not blocked by memory-store conflicts when they do not need memory records.
- Existing file-search ranking, line-range, semantic-refresh, and CLI/MCP parity tests are fixed or intentionally rebaselined with documented contracts.
- MCP operation and session-capture timeout tests are stable under focused execution.
- Full-suite verification avoids Node heap OOM, or the repo has a documented partitioned-suite command set that preserves failing-test visibility.
- Graphify hook status/install guidance is documented and verified.
- `npm run build` and the focused Sprint 62 verification suite pass.

## Out Of Scope

- Adding graphify query/path/explain MCP tools.
- Changing embedding defaults.
- Deleting legacy memory snapshots without explicit backup.
- Rewriting file-search ranking beyond existing contract stabilization.

## Shared Kernel

Serialize work touching:

- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/src/sqlite-sidecar-internal.ts`
- `ts/packages/runtime/src/cli.ts`
- `ts/packages/runtime/src/mcp/operations-tools.ts`
- `ts/packages/runtime/src/file-search-index.ts`
- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/session-capture.ts`

## Workstreams

- `memory-repair`: native-store conflict inspect, dry-run, backup, and explicit repair.
- `file-search-stability`: ranking, line-range, semantic-refresh, and CLI/MCP parity failures.
- `mcp-session-stability`: MCP operation and session-capture timeouts.
- `test-harness`: OOM mitigation and repeatable verification.
- `graphify-maintenance`: hook status/install runbook.
- `docs-handoff`: index and sprint status updates.

## Phase 0: RED Tests And Diagnostics

### Task 62.0.1: RED Native-Store Conflict Inspect Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "62.0.1",
  "category": "test",
  "workstream": "memory-repair",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Conflicting native-store.json and SQLite memory DB can be inspected without mutation.",
    "Inspection reports jsonOnly, sqliteOnly, differing, identical, jsonPath, memoryDbPath, and counts.",
    "Invalid JSON returns a clear diagnostic and does not touch SQLite."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ]
}
```

### Task 62.0.2: RED Native-Store Repair Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "62.0.2",
  "category": "test",
  "workstream": "memory-repair",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ],
  "blocked_by": [
    "62.0.1"
  ],
  "acceptance_criteria": [
    "Dry-run repair prints intended action and backup paths without mutation.",
    "Repair requires explicit authority: sqlite, json, or abort.",
    "SQLite-authority repair backs up native-store.json before clearing the active conflict.",
    "JSON-authority repair imports JSON records into SQLite transactionally or refuses safely."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ]
}
```

### Task 62.0.3: Characterize File-Search Failures

Metadata:

```json
{
  "phase": "0",
  "task_id": "62.0.3",
  "category": "diagnostic",
  "workstream": "file-search-stability",
  "agent_role": "explorer",
  "reasoning_effort": "medium",
  "owned_paths": [],
  "blocked_by": [],
  "acceptance_criteria": [
    "Each failing file-search test is classified as regression, stale expectation, or harness flake.",
    "The smallest source/test write scope is identified for each fix.",
    "No implementation changes are made by this task."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts ts/packages/runtime/tests/sprint-50-file-search-path-prior.test.ts ts/packages/runtime/tests/sprint-54-file-search-cli-mcp-parity.test.ts"
  ]
}
```

### Task 62.0.4: Characterize MCP And Session Timeouts

Metadata:

```json
{
  "phase": "0",
  "task_id": "62.0.4",
  "category": "diagnostic",
  "workstream": "mcp-session-stability",
  "agent_role": "explorer",
  "reasoning_effort": "medium",
  "owned_paths": [],
  "blocked_by": [],
  "acceptance_criteria": [
    "Timeouts are reproduced under focused execution or documented as full-suite-only.",
    "Root cause is classified as lifecycle leak, fixture size, slow startup, or timeout threshold.",
    "Open child process cleanup expectations are documented."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-38-file-search-extension-tool-contract.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-scan-contract.test.ts ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts ts/packages/runtime/tests/sprint-46-mcp-operations.test.ts ts/packages/runtime/tests/session-capture.test.ts"
  ]
}
```

### Task 62.0.5: Establish Test-Harness OOM Baseline

Metadata:

```json
{
  "phase": "0",
  "task_id": "62.0.5",
  "category": "diagnostic",
  "workstream": "test-harness",
  "agent_role": "explorer",
  "reasoning_effort": "medium",
  "owned_paths": [],
  "blocked_by": [],
  "acceptance_criteria": [
    "Full-suite OOM is reproduced with memory telemetry or ruled out after focused fixes.",
    "The plan chooses heap-size wrapper, Vitest pool tuning, or documented suite partitioning.",
    "The chosen approach does not hide failing tests."
  ],
  "commands": [
    "npm test"
  ]
}
```

## Phase 1: Memory Conflict Repair

### Task 62.1.1: Implement Conflict Diff Core

Metadata:

```json
{
  "phase": "1",
  "task_id": "62.1.1",
  "category": "impl",
  "workstream": "memory-repair",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/store.ts",
    "ts/packages/runtime/src/sqlite-sidecar-internal.ts"
  ],
  "blocked_by": [
    "62.0.1"
  ],
  "acceptance_criteria": [
    "Conflict comparison reuses openNativeStore migration normalization.",
    "Comparison can run without opening file-search DB handles.",
    "Diff result is serializable and stable for CLI/MCP output."
  ]
}
```

### Task 62.1.2: Add CLI Inspect And Repair Commands

Metadata:

```json
{
  "phase": "1",
  "task_id": "62.1.2",
  "category": "impl",
  "workstream": "memory-repair",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ],
  "blocked_by": [
    "62.1.1",
    "62.0.2"
  ],
  "acceptance_criteria": [
    "CLI exposes conflict inspect with JSON output.",
    "CLI exposes dry-run repair.",
    "CLI requires explicit authority for mutation.",
    "Mutation creates timestamped backups and reports paths."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts"
  ]
}
```

### Task 62.1.3: Decouple File-Search Status From Memory Conflict

Metadata:

```json
{
  "phase": "1",
  "task_id": "62.1.3",
  "category": "impl",
  "workstream": "memory-repair",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/mcp/operations-tools.ts"
  ],
  "blocked_by": [
    "62.1.1"
  ],
  "acceptance_criteria": [
    "file-search-status can inspect file-search DB without memory migration.",
    "file-search and file-search-related keep explicit scan semantics.",
    "Memory search/store/prune still fail closed on unresolved conflicts."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-54-file-search-cli-mcp-parity.test.ts ts/packages/runtime/tests/sprint-58-file-search-runtime-surfaces.test.ts"
  ]
}
```

## Phase 2: File-Search Contract Stabilization

### Task 62.2.1: Fix Semantic Refresh Reuse And Refresh-Needed Search

Metadata:

```json
{
  "phase": "2",
  "task_id": "62.2.1",
  "category": "impl",
  "workstream": "file-search-stability",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-db.ts",
    "ts/packages/runtime/src/file-search-index.ts",
    "ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts",
    "ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts"
  ],
  "blocked_by": [
    "62.0.3"
  ],
  "acceptance_criteria": [
    "Unchanged chunk embeddings are not refreshed repeatedly.",
    "Hybrid search with refresh-needed metadata still returns compatible lexical hits.",
    "Semantic diagnostics remain accurate after partial refresh failures."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts"
  ]
}
```

### Task 62.2.2: Fix Line-Range And CLI/MCP Parity Drift

Metadata:

```json
{
  "phase": "2",
  "task_id": "62.2.2",
  "category": "impl",
  "workstream": "file-search-stability",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-semble.ts",
    "ts/packages/runtime/src/file-search-index.ts",
    "ts/packages/runtime/src/file-search-query.ts",
    "ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts",
    "ts/packages/runtime/tests/sprint-54-file-search-cli-mcp-parity.test.ts"
  ],
  "blocked_by": [
    "62.0.3"
  ],
  "acceptance_criteria": [
    "Legacy rows without line metadata remain searchable.",
    "Chunk endLine expectations are consistent across CLI, MCP, and direct surfaces.",
    "Line-range behavior is documented as inclusive and fixture-backed."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts ts/packages/runtime/tests/sprint-54-file-search-cli-mcp-parity.test.ts"
  ]
}
```

### Task 62.2.3: Reconcile Path-Prior Ranking Contract

Metadata:

```json
{
  "phase": "2",
  "task_id": "62.2.3",
  "category": "impl",
  "workstream": "file-search-stability",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-index.ts",
    "ts/packages/runtime/tests/sprint-50-file-search-path-prior.test.ts",
    "ts/packages/runtime/tests/sprint-51-file-search-rank-parity.test.ts",
    "ts/packages/runtime/tests/sprint-58-file-search-hybrid-regression.test.ts"
  ],
  "blocked_by": [
    "62.0.3"
  ],
  "acceptance_criteria": [
    "Routing/path-prior queries prefer implementation code where the existing contract requires it.",
    "Docs/specs remain findable for documentation-oriented queries.",
    "Sprint 51 and Sprint 58 ranking parity tests remain green."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-50-file-search-path-prior.test.ts ts/packages/runtime/tests/sprint-51-file-search-rank-parity.test.ts ts/packages/runtime/tests/sprint-58-file-search-hybrid-regression.test.ts"
  ]
}
```

## Phase 3: MCP, Session, And Test-Harness Stability

### Task 62.3.1: Stabilize MCP Operation Tests

Metadata:

```json
{
  "phase": "3",
  "task_id": "62.3.1",
  "category": "impl",
  "workstream": "mcp-session-stability",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/operations-tools.ts",
    "ts/packages/runtime/src/mcp/operations-server.ts",
    "ts/packages/runtime/tests/sprint-38-file-search-extension-tool-contract.test.ts",
    "ts/packages/runtime/tests/sprint-38-file-search-extension-scan-contract.test.ts",
    "ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts",
    "ts/packages/runtime/tests/sprint-46-mcp-operations.test.ts"
  ],
  "blocked_by": [
    "62.0.4",
    "62.1.3"
  ],
  "acceptance_criteria": [
    "Focused MCP operation suites pass without timeout.",
    "Server lifecycle cleanup closes child processes and DB handles.",
    "Timeout increases are used only after lifecycle and fixture-size causes are ruled out."
  ]
}
```

### Task 62.3.2: Stabilize Session Capture Timeout

Metadata:

```json
{
  "phase": "3",
  "task_id": "62.3.2",
  "category": "impl",
  "workstream": "mcp-session-stability",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/session-capture.ts",
    "ts/packages/runtime/tests/session-capture.test.ts",
    "ts/packages/runtime/tests/sprint-60-session-capture-raw-artifact-safety.test.ts"
  ],
  "blocked_by": [
    "62.0.4"
  ],
  "acceptance_criteria": [
    "Session capture tests pass under focused execution.",
    "Sensitive support fields remain filtered.",
    "Summarizer fallback behavior is deterministic and bounded in tests."
  ]
}
```

### Task 62.3.3: Add Repeatable Full-Suite Strategy

Metadata:

```json
{
  "phase": "3",
  "task_id": "62.3.3",
  "category": "impl",
  "workstream": "test-harness",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "package.json",
    "vitest.config.ts",
    "docs/sprint-62-runtime-stabilization-before-new-features.md"
  ],
  "blocked_by": [
    "62.0.5",
    "62.2.1",
    "62.2.2",
    "62.2.3",
    "62.3.1",
    "62.3.2"
  ],
  "acceptance_criteria": [
    "The repo has a documented way to run the full suite without Node heap OOM.",
    "Any new test script preserves failing-test visibility.",
    "Build and partitioned tests are clear enough for future sessions."
  ]
}
```

## Phase 4: Graphify Maintenance Gate

### Task 62.4.1: Document And Verify Graphify Hook Maintenance

Metadata:

```json
{
  "phase": "4",
  "task_id": "62.4.1",
  "category": "docs",
  "workstream": "graphify-maintenance",
  "agent_role": "worker",
  "reasoning_effort": "low",
  "owned_paths": [
    "README.md",
    "docs/README.md",
    "docs/sprint-62-runtime-stabilization-before-new-features.md"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Docs name graphify hook status and hook install commands.",
    "Docs state when graphify update is required.",
    "Sprint handoff records whether hooks are installed at completion."
  ],
  "commands": [
    "graphify hook status",
    "graphify hook install",
    "graphify hook status"
  ]
}
```

## Phase 5: Integration Verification

### Task 62.5.1: Stabilization Gate

Metadata:

```json
{
  "phase": "5",
  "task_id": "62.5.1",
  "category": "validation",
  "workstream": "integration",
  "agent_role": "default",
  "reasoning_effort": "high",
  "owned_paths": [],
  "blocked_by": [
    "62.1.2",
    "62.1.3",
    "62.2.1",
    "62.2.2",
    "62.2.3",
    "62.3.1",
    "62.3.2",
    "62.3.3",
    "62.4.1"
  ],
  "acceptance_criteria": [
    "All Sprint 62 focused tests pass.",
    "npm run build passes.",
    "Full-suite or documented partitioned-suite verification is green.",
    "Runtime conflict repair path is documented with dry-run first.",
    "Graphify hook status is known and recorded."
  ],
  "commands": [
    "npm run build",
    "npm test -- ts/packages/runtime/tests/sprint-62-native-store-conflict-repair.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts ts/packages/runtime/tests/sprint-50-file-search-path-prior.test.ts ts/packages/runtime/tests/sprint-54-file-search-cli-mcp-parity.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-38-file-search-extension-tool-contract.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-scan-contract.test.ts ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts ts/packages/runtime/tests/sprint-46-mcp-operations.test.ts ts/packages/runtime/tests/session-capture.test.ts",
    "graphify hook status"
  ]
}
```

## Execution Notes

- Do not repair the live `~/.byomem/runtime` conflict without dry-run output and an explicit authority choice.
- Treat test expectation edits as code changes: require failing characterization first, then an implementation or contract decision.
- Keep unrelated worktree edits intact.
