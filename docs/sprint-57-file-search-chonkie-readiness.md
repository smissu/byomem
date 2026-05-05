# Sprint 57: Chonkie-Ready File-Search Scanning

> Use `sprint-implementation` to execute this plan task-by-task after review.

## Objective

Eliminate the runtime race where BYOMem file-search scanning can fall back to 50-line chunks for code files because Chonkie chunkers are still initializing. The goal is to make code-aware chunking deterministic for scan paths that can be async, preserve the existing synchronous scan contract where required, and expose enough diagnostics to prove whether Chonkie or fallback line chunking was used.

## Why This Is A Sprint

This is larger than a one-file fix because the scanner contract is currently synchronous:

- `chunkFileContent()` is synchronous and falls back when no Chonkie chunker is present.
- `chonkieCodeChunkersReady` is an async module-load promise.
- `scanAndIndex()` is used by open/manual scans, scheduler, poller, CLI, Pi, MCP, and tests.
- Runtime-local async scan jobs already exist and are the best candidate surface for awaiting Chonkie readiness without breaking synchronous callers.

Do not simply make `scanAndIndex()` async unless every caller and public contract is updated under tests.

## Current State

- `ts/packages/runtime/src/file-search-semble.ts` starts Chonkie initialization at module load through `chonkieCodeChunkersReady`.
- `chunkCodeAware()` falls back to line chunks when `chonkieCodeChunkers.get(language)` returns no chunker.
- `ts/packages/runtime/src/file-search-db.ts` calls `chunkFileContent()` during `ensureIndexedSnapshot()`.
- `FileSearchScanManager` supports async runtime-local jobs, but the underlying scan runner may still call the synchronous scan path.
- Sprint 49 has Chonkie parity tests that explicitly await readiness before comparing chunk output.
- Runtime scans do not currently expose whether chunks came from Chonkie or fallback line chunking.

## Success Criteria

- Async/runtime scan paths can wait for Chonkie readiness before indexing code files.
- Existing synchronous `scanAndIndex()` behavior remains backward compatible and documented.
- Code files scanned through the async-ready path do not use line fallback merely because Chonkie initialization is pending.
- "Chunker not ready" is treated as a distinct state, not as an ordinary line-fallback reason.
- Missing WASM, unsupported language, non-code files, and Chonkie exceptions still fall back safely.
- Scanner/status diagnostics make Chonkie readiness and fallback usage observable.
- CLI, MCP, Pi, poller, and scheduler behavior remains compatible.
- BYOMem/Semble benchmark can show whether chunk boundaries now match Semble more closely for implementation-specific queries.

## Out Of Scope

- Ranking policy changes.
- Replacing Chonkie or changing model/embedding behavior.
- Removing SQLite persistence.
- Durable cross-process scan jobs.
- Making every existing sync call site async in one broad rewrite unless tests prove it is necessary.

## Shared Kernel

Serialize changes to these files:

- `ts/packages/runtime/src/file-search-semble.ts`
- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/file-search-scan-manager.ts`
- `ts/packages/runtime/src/file-search-active-poller.ts`
- `ts/packages/runtime/src/file-index-scheduler.ts`
- `ts/packages/runtime/src/pi-extension.ts`
- `ts/packages/runtime/src/mcp/operations-tools.ts`
- `ts/packages/runtime/src/cli.ts`

Test and benchmark workers can run in parallel only when their write sets are disjoint.

## Phase 0: RED Tests And Contract Lock

### Task 57.0.1: Chunker Readiness Contract Tests

Metadata:

```json
{
  "phase": "0",
  "task_id": "57.0.1",
  "category": "test",
  "workstream": "chunking-contract",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-57-file-search-chonkie-readiness.test.ts"
  ]
}
```

Acceptance criteria:

- A test proves a code-aware scan path waits for Chonkie readiness before chunking code files.
- A test proves unsupported languages and missing chunkers still fall back deterministically.
- A test proves non-code/text files do not wait unnecessarily.
- A test proves Chonkie exceptions are reported as fallback rather than crashing the scan.

RED command:

```bash
npm test -- ts/packages/runtime/tests/sprint-57-file-search-chonkie-readiness.test.ts
```

### Task 57.0.2: Async Scan Surface Tests

Metadata:

```json
{
  "phase": "0",
  "task_id": "57.0.2",
  "category": "test",
  "workstream": "runtime-scan",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-57-file-search-chonkie-async-scan.test.ts"
  ],
  "blocked_by": ["57.0.1"]
}
```

Acceptance criteria:

- Runtime-local async scan jobs wait for Chonkie readiness before indexing code files.
- Existing same-project duplicate and concurrency semantics from Sprint 43 remain intact.
- The async job status includes scanner/chunker diagnostics once available.
- Failed Chonkie initialization does not fail the job unless the underlying scan fails.

RED command:

```bash
npm test -- ts/packages/runtime/tests/sprint-57-file-search-chonkie-async-scan.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
```

### Task 57.0.3: Sync Compatibility Tests

Metadata:

```json
{
  "phase": "0",
  "task_id": "57.0.3",
  "category": "test",
  "workstream": "compatibility",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-57-file-search-chonkie-sync-compat.test.ts"
  ],
  "blocked_by": ["57.0.1"]
}
```

Acceptance criteria:

- `scanAndIndex()` remains synchronous unless the sprint explicitly changes the public contract.
- Open/manual scan callers still return existing scanner status payloads.
- CLI synchronous scan remains synchronous.
- If sync scans cannot guarantee Chonkie readiness, diagnostics clearly report fallback or readiness state.

RED command:

```bash
npm test -- ts/packages/runtime/tests/sprint-57-file-search-chonkie-sync-compat.test.ts ts/packages/runtime/tests/cli.test.ts
```

### Task 57.0.4: Benchmark/Parity Harness

Metadata:

```json
{
  "phase": "0",
  "task_id": "57.0.4",
  "category": "test",
  "workstream": "benchmark",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-57-file-search-chonkie-parity-benchmark.test.ts"
  ]
}
```

Acceptance criteria:

- Benchmark records whether chunks were produced by Chonkie or fallback.
- Benchmark includes the implementation-specific query:
  - `configured concurrency caps embedMany batch size refreshSemanticIndex`
- Benchmark captures chunk ranges for `ts/packages/runtime/src/file-search-db.ts`.
- Benchmark compares BYOMem chunk boundaries/search ranking with Semble output.

RED command:

```bash
npm test -- ts/packages/runtime/tests/sprint-57-file-search-chonkie-parity-benchmark.test.ts
```

## Phase 1: Chunker Readiness Core

### Task 57.1.1: Add Chunker Readiness API

Metadata:

```json
{
  "phase": "1",
  "task_id": "57.1.1",
  "category": "impl",
  "workstream": "chunking-core",
  "agent_role": "worker",
  "model": "gpt-5.4",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-semble.ts"
  ],
  "blocked_by": ["57.0.1"]
}
```

Implementation notes:

- Keep `chunkFileContent()` synchronous for compatibility.
- Add an explicit readiness API, for example `ensureFileSearchCodeChunkersReady()`, that awaits `chonkieCodeChunkersReady` and exposes cached readiness/failure diagnostics.
- Add an async readiness-aware helper, for example `chunkFileContentReady()` or `prepareFileSearchCodeChunkers()`.
- Expose structured metadata for chunk source:
  - `chonkie`
  - `line-fallback`
  - `not-ready`
  - `unsupported-language`
  - `missing-wasm`
  - `chunker-error`
- Avoid sleeping or arbitrary polling. Await the existing readiness promise.
- Do not let the async-ready path silently fall back to line chunks solely because readiness is still pending.

Acceptance criteria:

- Chonkie readiness tests pass.
- Existing Sprint 49 Chonkie parity tests still pass.

### Task 57.1.2: Add Scanner Chonkie Diagnostics

Metadata:

```json
{
  "phase": "1",
  "task_id": "57.1.2",
  "category": "impl",
  "workstream": "scanner-core",
  "agent_role": "worker",
  "model": "gpt-5.4",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-db.ts"
  ],
  "blocked_by": ["57.1.1", "57.0.3"]
}
```

Implementation notes:

- Extend scanner progress/status with chunker diagnostics while preserving existing payload compatibility.
- Count code files chunked by Chonkie vs fallback.
- Record fallback reasons without including file contents.
- Keep synchronous scan behavior stable.

Acceptance criteria:

- Sync compatibility tests pass.
- Existing scanner status tests remain green.

## Phase 2: Async-Ready Scan Path

### Task 57.2.1: Add Async Scan Runner Path

Metadata:

```json
{
  "phase": "2",
  "task_id": "57.2.1",
  "category": "impl",
  "workstream": "runtime-scan",
  "agent_role": "worker",
  "model": "gpt-5.4",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-db.ts",
    "ts/packages/runtime/src/file-search-scan-manager.ts"
  ],
  "blocked_by": ["57.1.1", "57.1.2", "57.0.2"]
}
```

Implementation notes:

- Prefer adding an explicit async scan method or runner rather than converting every existing sync caller.
- Runtime-local async jobs should use the readiness-aware chunking path.
- Preserve `scanAndIndex()` as a synchronous compatibility path unless the final design explicitly migrates all callers.
- For sync compatibility, choose and document one behavior:
  - compatibility mode: sync scan may line-fallback but reports `not-ready`
  - strict mode: sync scan throws a deterministic `code-chunkers-not-ready-use-async-scan` error
- Ensure index revision/hot-index invalidation still happens after scan completion/failure according to current contracts.

Acceptance criteria:

- Runtime-local async scan tests pass.
- Sprint 43 async scan tests remain green.

### Task 57.2.2: Wire Pi/MCP Runtime Surfaces

Metadata:

```json
{
  "phase": "2",
  "task_id": "57.2.2",
  "category": "impl",
  "workstream": "runtime-surfaces",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/src/pi-extension.ts",
    "ts/packages/runtime/src/mcp/operations-tools.ts"
  ],
  "blocked_by": ["57.2.1"]
}
```

Implementation notes:

- Use the async-ready scan path only where the public surface is already async or explicitly runtime-local async.
- Do not silently change default synchronous scan behavior.
- Include chunker diagnostics in status/search metadata only where existing payloads can safely accept optional fields.

Acceptance criteria:

- Pi/MCP scan/status tests pass.
- Status remains read-only.

### Task 57.2.3: Wire Poller/Scheduler/CLI Compatibility

Metadata:

```json
{
  "phase": "2",
  "task_id": "57.2.3",
  "category": "impl",
  "workstream": "compatibility-surfaces",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-active-poller.ts",
    "ts/packages/runtime/src/file-index-scheduler.ts",
    "ts/packages/runtime/src/cli.ts"
  ],
  "blocked_by": ["57.2.1"]
}
```

Implementation notes:

- Decide per surface whether it should stay sync with diagnostics or move to the async-ready runner.
- CLI should remain deterministic and avoid hidden background work.
- Scheduler/poller should not start unbounded concurrent async work.

Acceptance criteria:

- CLI tests pass.
- Poller/scheduler tests pass.
- No scan/status caller accidentally starts semantic refresh unless explicitly configured.

## Phase 3: Verification And Benchmark

### Task 57.3.1: Focused Regression Suite

Metadata:

```json
{
  "phase": "3",
  "task_id": "57.3.1",
  "category": "verify",
  "workstream": "regression",
  "agent_role": "worker",
  "blocked_by": ["57.2.2", "57.2.3"]
}
```

Verification command:

```bash
npm test -- \
  ts/packages/runtime/tests/sprint-57-file-search-chonkie-readiness.test.ts \
  ts/packages/runtime/tests/sprint-57-file-search-chonkie-async-scan.test.ts \
  ts/packages/runtime/tests/sprint-57-file-search-chonkie-sync-compat.test.ts \
  ts/packages/runtime/tests/sprint-49-file-search-chonkie-parity.test.ts \
  ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts \
  ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
  ts/packages/runtime/tests/cli.test.ts
```

### Task 57.3.2: Reindex And Compare Against Semble

Metadata:

```json
{
  "phase": "3",
  "task_id": "57.3.2",
  "category": "benchmark",
  "workstream": "parity",
  "agent_role": "worker",
  "blocked_by": ["57.3.1"]
}
```

Acceptance criteria:

- Rebuild BYOMem file-search DB after the sensitive-marker fix and Chonkie readiness change.
- Confirm `ts/packages/runtime/src/file-search-db.ts` is indexed.
- Confirm chunk ranges for `refreshSemanticIndex` are produced by Chonkie or have a documented fallback reason.
- Compare BYOMem and Semble for:
  - index speed
  - BM25 results
  - semantic results
  - hybrid results
  - target implementation query ranking

Suggested query:

```text
configured concurrency caps embedMany batch size refreshSemanticIndex
```

## Execution Notes

- Use `sprint-implementation` for execution.
- Use subagents for separate test, implementation, review, and benchmark slices.
- Keep shared-kernel edits serialized.
- Do not let multiple workers edit `file-search-db.ts` or `file-search-semble.ts` concurrently.
- Run `graphify update .` after code changes.
- Because the repository currently has broad file-search changes in progress, implementation should begin with a scoped `git status --short` review and explicit ownership boundaries.

## Open Design Decision

The sprint should choose one of these before implementation starts:

1. **Preferred:** Add an explicit async-ready scan path and route runtime-local async scans through it, while keeping `scanAndIndex()` synchronous.
2. **Broader:** Convert `scanAndIndex()` and all callers to async under tests.

Recommendation: choose option 1. It provides Chonkie determinism for runtime scans without creating a broad public contract migration.
