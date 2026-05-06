# Sprint 61: DB-Only Memory Storage

> Use `sprint-implementation` to execute this plan task-by-task after review.
> This plan is eKanban-ready, but the current Codex session does not expose an eKanban MCP tool.

## Implementation Status

Implemented in this session using Codex orchestration. The DB-only storage, one-time JSON migration, read-only SQLite path, runtime status, file-search artifact exclusion, and docs audit slices are complete. Focused Sprint 61 verification passed; the full parallel suite still has unrelated file-search contract failures and a Node heap OOM noted in the session handoff.

## Objective

Make `byomem-index.sqlite` the canonical BYOMem memory store and retire `native-store.json` from active runtime storage. The runtime must still safely import legacy `native-store.json` snapshots exactly once, preserve user/project memories, and keep file search DB-only and independent.

## Why This Is A Sprint

This is a shared-kernel storage migration across memory persistence, search, read-only MCP, CLI/Pi surfaces, session-capture assertions, and file-search exclusion policy.

- `openNativeStore()` currently loads `native-store.json`, keeps an in-memory `recordsById`, writes SQLite sidecar rows, and rewrites JSON on write/prune/close.
- SQLite already has canonical memory tables, FTS, embeddings, and revision tracking, but it is still treated as a searchable mirror rather than the only durable memory store.
- Read-only MCP still loads `native-store.json` directly.
- Several tests and docs assert `native-store.json` creation or inspect it as the durable record source.
- A bad migration could resurrect pruned memories, lose legacy records, or leak legacy JSON backup files into file search.

## Current State

- `ts/packages/runtime/src/store.ts` opens `native-store.json`, builds `recordsById`, delegates writes to the SQLite sidecar, then persists JSON.
- `ts/packages/runtime/src/sqlite-sidecar-internal.ts` already provides `records`, `records_fts`, `embedding_cache`, `record_embeddings`, `memory_search_index_revisions`, `sidecar.read()`, `sidecar.list()`, `syncWrite()`, and `syncPrune()`.
- `ts/packages/runtime/src/search-index.ts` already prefers `MemorySearchIndex` backed by SQLite and only falls back to `store.list()` when no sidecar rows exist.
- `ts/packages/runtime/src/readonly-core.ts` still opens a read-only store by loading `native-store.json`.
- File search already uses `byomem-file-search.sqlite`, not `native-store.json`, but must continue excluding legacy JSON snapshots and migration backups.

## Success Criteria

- Fresh memory writes create/update SQLite memory rows and do not create or update `native-store.json`.
- `store.write`, `store.read`, `store.list`, `store.prune`, and `store.close` are backed by SQLite canonical records.
- Existing `native-store.json` snapshots migrate into SQLite exactly once when safe.
- Migration preserves `id`, `scope`, normalized identity, content, provenance, `createdAt`, and `updatedAt`.
- Successful migration renames the legacy snapshot to a non-active backup path; failed migration leaves legacy data untouched.
- JSON/SQLite conflicts fail closed with a clear error and do not silently merge or delete data.
- Search/read/CLI/MCP/Pi/session-capture behavior remains compatible after switching to DB-only memory storage.
- Read-only MCP opens memory records from SQLite and does not require `native-store.json`.
- Public runtime status names the canonical memory DB path clearly.
- File search continues to ignore memory DB artifacts and legacy `native-store.json` backups.
- No active test expects `native-store.json` creation for normal memory writes.

## Out Of Scope

- Renaming `byomem-index.sqlite` to a new memory DB filename.
- Deleting legacy JSON snapshots without a backup.
- Importing arbitrary historical/project-local memory snapshots outside the active runtime base dir.
- Redesigning memory search ranking or embeddings beyond removing JSON fallback assumptions.
- Changing file-search storage architecture.

## Migration Policy

- On `openNativeStore()`, open SQLite first.
- If `native-store.json` does not exist: run normal SQLite-only mode.
- If `native-store.json` exists and SQLite `records` is empty: transactionally import all JSON records into SQLite records/FTS, preserve metadata, bump memory index revision, then rename JSON to `native-store.json.migrated`.
- If `native-store.json` exists and SQLite has identical records: rename JSON to `native-store.json.migrated`.
- If `native-store.json` exists and SQLite differs: fail closed with a clear conflict error; do not merge, delete, or rename.
- Migration must not require remote embeddings. Records and FTS import first; embeddings can be missing/refresh-needed and refreshed later.
- After migration, runtime never rewrites `native-store.json`.

## Shared Kernel

Serialize work touching these files:

- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/src/sqlite-sidecar-internal.ts`
- `ts/packages/runtime/src/sqlite-sidecar.ts`
- `ts/packages/runtime/src/search-index.ts`
- `ts/packages/runtime/src/readonly-core.ts`

Runtime surface and docs tasks must wait for the shared storage contract.

## Workstreams

- `contract-tests`: RED tests for DB-only writes, reopen, prune, no JSON creation, and search.
- `migration-tests`: RED tests for legacy JSON import, idempotence, conflict handling, and metadata preservation.
- `shared-kernel`: `NativeStore` SQLite canonical refactor and migration helper.
- `search-read`: remove JSON fallback assumptions and make read-only runtime SQLite-backed.
- `runtime-surfaces`: CLI, Pi, MCP, status, session-capture test assertions.
- `file-search-guards`: keep legacy JSON/migration backups excluded from file search.
- `docs-audit`: update docs and run compatibility grep.

## Phase 0: RED Tests And Contract Locking

### Task 61.0.1: RED DB-Only Store Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "61.0.1",
  "category": "test",
  "workstream": "contract-tests",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-61-db-only-memory-store.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Fresh write creates SQLite memory rows and no native-store.json.",
    "read/list/reopen work from SQLite records.",
    "prune removes SQLite records, FTS rows, embeddings, and hot-index visibility.",
    "close does not create native-store.json."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-61-db-only-memory-store.test.ts"
  ]
}
```

### Task 61.0.2: RED Legacy JSON Import And Conflict Handling

Metadata:

```json
{
  "phase": "0",
  "task_id": "61.0.2",
  "category": "test",
  "workstream": "migration-tests",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-61-native-store-json-migration.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Existing native-store.json imports into empty SQLite.",
    "Import preserves id, scope, identity, content, provenance, createdAt, and updatedAt.",
    "Import is idempotent when SQLite already contains identical records.",
    "Conflicting JSON and SQLite records fail with a clear migration conflict and leave JSON untouched.",
    "Successful migration renames JSON to native-store.json.migrated."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-61-native-store-json-migration.test.ts"
  ]
}
```

### Task 61.0.3: RED Runtime Surface Compatibility

Metadata:

```json
{
  "phase": "0",
  "task_id": "61.0.3",
  "category": "test",
  "workstream": "runtime-surfaces",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/cli.test.ts",
    "ts/packages/runtime/tests/byomem-extension-wiring.test.ts",
    "ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts",
    "ts/packages/runtime/tests/sprint-45-readonly-core.test.ts",
    "ts/packages/runtime/tests/sprint-60-session-capture-raw-artifact-safety.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "CLI store/search/prune no longer expects native-store.json.",
    "Pi/session-capture assertions inspect SQLite memory records.",
    "Read-only runtime opens SQLite without requiring JSON.",
    "Failure cases assert zero SQLite records rather than an empty JSON snapshot."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts ts/packages/runtime/tests/sprint-45-readonly-core.test.ts ts/packages/runtime/tests/sprint-60-session-capture-raw-artifact-safety.test.ts"
  ]
}
```

### Task 61.0.4: RED File-Search Legacy Artifact Exclusion

Metadata:

```json
{
  "phase": "0",
  "task_id": "61.0.4",
  "category": "test",
  "workstream": "file-search-guards",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-61-file-search-memory-artifact-exclusion.test.ts",
    "ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "File search ignores legacy native-store.json.",
    "File search ignores native-store.json.migrated backups.",
    "File-search DB path guards still reject memory DB paths.",
    "File-search behavior remains DB-only and does not depend on NativeStore JSON."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-61-file-search-memory-artifact-exclusion.test.ts ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts"
  ]
}
```

## Phase 1: Shared Kernel Implementation

### Task 61.1.1: Make SQLite The NativeStore Canonical Backend

Metadata:

```json
{
  "phase": "1",
  "task_id": "61.1.1",
  "category": "impl",
  "workstream": "shared-kernel",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/store.ts",
    "ts/packages/runtime/src/sqlite-sidecar-internal.ts",
    "ts/packages/runtime/src/sqlite-sidecar.ts"
  ],
  "blocked_by": [
    "61.0.1"
  ],
  "acceptance_criteria": [
    "Remove active loadSnapshot/persistSnapshot write path from NativeStore.",
    "NativeStore read/list delegate to SQLite sidecar.",
    "NativeStore write/prune delegate to internal sidecar mutator.",
    "CreatedAt preservation comes from existing SQLite records.",
    "Single-writer owner guard remains intact."
  ]
}
```

### Task 61.1.2: Add One-Time Native JSON Migration

Metadata:

```json
{
  "phase": "1",
  "task_id": "61.1.2",
  "category": "impl",
  "workstream": "migration-tests",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/store.ts",
    "ts/packages/runtime/src/sqlite-sidecar-internal.ts"
  ],
  "blocked_by": [
    "61.0.2",
    "61.1.1"
  ],
  "acceptance_criteria": [
    "Import JSON only when SQLite records table is empty or identical.",
    "Import all records inside one SQLite transaction.",
    "Do not require remote embeddings during migration.",
    "Rename native-store.json to native-store.json.migrated after successful import.",
    "Conflict errors preserve JSON and SQLite unchanged."
  ]
}
```

## Phase 2: Search And Read Runtime

### Task 61.2.1: Remove JSON Fallback Search/Read Assumptions

Metadata:

```json
{
  "phase": "2",
  "task_id": "61.2.1",
  "category": "impl",
  "workstream": "search-read",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/search-index.ts",
    "ts/packages/runtime/src/readonly-core.ts",
    "ts/packages/runtime/tests/sprint-59-memory-search-review-regressions.test.ts",
    "ts/packages/runtime/tests/native-store-retrieval-baseline.test.ts",
    "ts/packages/runtime/tests/store.test.ts",
    "ts/packages/runtime/tests/sprint-20-native-store.test.ts"
  ],
  "blocked_by": [
    "61.1.1",
    "61.1.2"
  ],
  "acceptance_criteria": [
    "Search uses SQLite/hot index after migration.",
    "Legacy JSON search fallback test becomes migration-then-search coverage.",
    "Read-only runtime reads SQLite records.",
    "Native store baseline tests assert SQLite persistence instead of JSON persistence."
  ]
}
```

### Task 61.2.2: Update CLI, MCP, Pi, And Session Assertions

Metadata:

```json
{
  "phase": "2",
  "task_id": "61.2.2",
  "category": "impl",
  "workstream": "runtime-surfaces",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/pi-extension.ts",
    "ts/packages/runtime/src/mcp/readonly-tools.ts",
    "ts/packages/runtime/src/mcp/operations-server.ts",
    "ts/packages/runtime/tests/cli.test.ts",
    "ts/packages/runtime/tests/byomem-extension-wiring.test.ts",
    "ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts",
    "ts/packages/runtime/tests/sprint-45-readonly-core.test.ts",
    "ts/packages/runtime/tests/sprint-60-session-capture-raw-artifact-safety.test.ts"
  ],
  "blocked_by": [
    "61.2.1",
    "61.0.3"
  ],
  "acceptance_criteria": [
    "Status reports canonical memory DB path clearly.",
    "No runtime surface describes JSON as the active native store.",
    "CLI/Pi/MCP tests assert DB records and no JSON creation.",
    "Session rollup tests inspect SQLite records and still prove sensitive data is not durable."
  ]
}
```

### Task 61.2.3: Preserve File-Search DB-Only Boundaries

Metadata:

```json
{
  "phase": "2",
  "task_id": "61.2.3",
  "category": "impl",
  "workstream": "file-search-guards",
  "agent_role": "worker",
  "model": "gpt-5.3-codex",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-db.ts",
    "ts/packages/runtime/tests/sprint-61-file-search-memory-artifact-exclusion.test.ts",
    "ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts",
    "docs/semantic-hybrid-document-search-runbook.md"
  ],
  "blocked_by": [
    "61.0.4",
    "61.1.2"
  ],
  "acceptance_criteria": [
    "Legacy native-store.json and native-store.json.migrated are ignored by scanner.",
    "File-search DB path guards reject active memory DB paths.",
    "Docs clarify file search has no native-store.json dependency."
  ]
}
```

## Phase 3: Docs, Audit, And Verification

### Task 61.3.1: Update Memory Storage Documentation

Metadata:

```json
{
  "phase": "3",
  "task_id": "61.3.1",
  "category": "docs",
  "workstream": "docs-audit",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "docs/session-memory-native-architecture.md",
    "docs/hermes-integration-checklist.md",
    "docs/semantic-hybrid-document-search-runbook.md",
    "docs/sprint-61-db-only-memory-storage.md"
  ],
  "blocked_by": [
    "61.2.1",
    "61.2.2",
    "61.2.3"
  ],
  "acceptance_criteria": [
    "Docs describe byomem-index.sqlite as canonical memory DB.",
    "Docs describe native-store.json as legacy import-only backup.",
    "Docs include migration conflict policy and rollback guidance.",
    "File-search docs keep legacy JSON exclusion policy."
  ]
}
```

### Task 61.3.2: Compatibility Audit Gate

Metadata:

```json
{
  "phase": "3",
  "task_id": "61.3.2",
  "category": "validation",
  "workstream": "docs-audit",
  "agent_role": "default",
  "reasoning_effort": "medium",
  "owned_paths": [],
  "blocked_by": [
    "61.3.1"
  ],
  "acceptance_criteria": [
    "No active test expects native-store.json creation for memory writes.",
    "Remaining native-store.json references are migration, legacy backup exclusion, or docs.",
    "No public runtime surface says JSON is canonical.",
    "Search fallback behavior is SQLite-first and migration-only for legacy JSON."
  ],
  "commands": [
    "rg -n \"native-store\\\\.json|loadSnapshot|persistSnapshot|JSON fallback|nativeStorePath\" docs ts/packages/runtime/src ts/packages/runtime/tests"
  ]
}
```

## Verification Gate

Run after implementation:

```bash
npm test -- ts/packages/runtime/tests/sprint-61-db-only-memory-store.test.ts ts/packages/runtime/tests/sprint-61-native-store-json-migration.test.ts ts/packages/runtime/tests/sprint-61-file-search-memory-artifact-exclusion.test.ts
npm test -- ts/packages/runtime/tests/store.test.ts ts/packages/runtime/tests/sprint-20-native-store.test.ts ts/packages/runtime/tests/write-path.test.ts ts/packages/runtime/tests/native-store-retrieval-baseline.test.ts ts/packages/runtime/tests/sqlite-sidecar.test.ts
npm test -- ts/packages/runtime/tests/sprint-59-memory-search-mode-contract.test.ts ts/packages/runtime/tests/sprint-59-memory-hot-index-backend.test.ts ts/packages/runtime/tests/sprint-59-memory-search-review-regressions.test.ts
npm test -- ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/sprint-45-mcp-readonly.test.ts ts/packages/runtime/tests/sprint-45-readonly-core.test.ts
npm test -- ts/packages/runtime/tests/sprint-60-session-capture-raw-artifact-safety.test.ts ts/packages/runtime/tests/sprint-60-session-artifact-file-search-exclusion.test.ts
npm run build
git diff --check
graphify update .
```

## Risks And Mitigations

- **JSON/SQLite drift:** fail closed on conflicts instead of silently merging.
- **Remote embedding dependency during migration:** import records/FTS first and leave embeddings refresh-needed if unavailable.
- **Read-only MCP breakage:** update `readonly-core.ts` in the same sprint, not as follow-up.
- **File-search privacy leak:** keep ignoring legacy JSON and migrated backups.
- **Status naming confusion:** rename/report canonical memory DB path rather than implying a JSON store path.
- **Broad test churn:** group mechanical test updates in runtime-surface task after the shared kernel is green.

## eKanban Readiness Notes

When an eKanban MCP tool is available, emit one parent sprint task with this metadata:

```json
{
  "type": "sprint",
  "sprint_number": "61",
  "objective": "Make BYOMem memory storage SQLite-only and retire native-store.json from active runtime storage.",
  "success_criteria": [
    "New memory writes do not create or update native-store.json.",
    "openNativeStore read/list/write/prune are backed by SQLite records.",
    "Existing native-store.json records migrate into SQLite exactly once.",
    "Search/read/CLI/MCP/Pi/session-capture behavior remains compatible.",
    "File search remains DB-only and excludes legacy memory JSON artifacts."
  ],
  "workstreams": [
    "contract-tests",
    "migration-tests",
    "shared-kernel",
    "search-read",
    "runtime-surfaces",
    "file-search-guards",
    "docs-audit"
  ],
  "file_changes": {
    "new": [
      "ts/packages/runtime/tests/sprint-61-db-only-memory-store.test.ts",
      "ts/packages/runtime/tests/sprint-61-native-store-json-migration.test.ts",
      "ts/packages/runtime/tests/sprint-61-file-search-memory-artifact-exclusion.test.ts"
    ],
    "modified": [
      "ts/packages/runtime/src/store.ts",
      "ts/packages/runtime/src/sqlite-sidecar-internal.ts",
      "ts/packages/runtime/src/sqlite-sidecar.ts",
      "ts/packages/runtime/src/search-index.ts",
      "ts/packages/runtime/src/readonly-core.ts",
      "ts/packages/runtime/src/cli.ts",
      "ts/packages/runtime/src/pi-extension.ts",
      "ts/packages/runtime/src/mcp/readonly-tools.ts",
      "ts/packages/runtime/src/mcp/operations-server.ts",
      "ts/packages/runtime/src/file-search-db.ts",
      "docs/session-memory-native-architecture.md",
      "docs/hermes-integration-checklist.md",
      "docs/semantic-hybrid-document-search-runbook.md"
    ],
    "deleted": []
  },
  "notes": "Use this metadata when emitting tasks once an eKanban MCP tool is available; no tasks were emitted in this session."
}
```
