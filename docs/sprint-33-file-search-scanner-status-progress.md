# Sprint 33: File Search Scanner Status and Progress

## Objective
Add explicit status and progress visibility for the BYOMem file-search scanner/indexer so users can understand what the scanner found, what it indexed, what changed, and whether work is currently in progress. This sprint keeps the scanner synchronous/on-demand and avoids watcher/daemon behavior while adding a stable status API, CLI surface, and test-covered diagnostics for scanner and embedding refresh progress.

## Scope
### In scope
- Add scanner/indexer status data to the file-search DB handle and file-search DB metadata/status tables only
- Track the most recent scan lifecycle: idle/running/completed/failed/abandoned, run id, trigger/source, project key/base dir identity, started/completed timestamps, duration, current/last path, discovered/scanned/indexed/unchanged/changed/deleted/ignored/error counts, chunks written, and bytes read if feasible
- Provide meaningful post-scan counts from the file-search DB: indexed files, chunks, projects, changed/reconciled rows, embedding coverage
- Define progress as last persisted scan summary plus coarse same-process synchronous counters; separate CLI processes should be documented as reading the latest persisted snapshot unless true cross-process observation is explicitly implemented and tested
- Add a public runtime API for scanner status/progress
- Add a CLI status surface for document search/indexing, e.g. `file-search-status` or `file-search --status`
- Include semantic embedding refresh/backfill status from Sprint 32 diagnostics where relevant
- Preserve `.gitignore` behavior and internal BYOMem file exclusion
- Add RED tests first for status snapshots, in-progress behavior, post-scan counts, error state, and CLI output
- Document scanner status usage and limitations

### Out of scope
- Watcher-based continuous monitoring, `fs.watch`, polling loops, or file-system event streams
- A long-running scanner daemon, background worker, hidden async scanner, or fire-and-forget scan task
- Real-time terminal UI/progress bar beyond a simple JSON/text status command
- Major scheduler redesign
- New vector/semantic search behavior beyond surfacing existing embedding diagnostics
- Full observability/metrics platform integration
- Rich scheduler control-plane redesign, including pending queue introspection, debounce deadline management, retry targeting, or multi-project concurrent progress beyond what the existing scheduler model safely supports
- Persisting every per-file progress event long-term

## Dependencies
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-30-file-index-scheduler-and-hardening.md`
- `docs/sprint-31-file-search-refinement-and-cleanup.md`
- `docs/sprint-32-semantic-hybrid-document-search.md`
- `docs/semantic-hybrid-document-search-runbook.md`
- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/file-index-scheduler.ts`
- `ts/packages/runtime/src/cli.ts`
- `ts/packages/runtime/src/index.ts`
- Existing sprint-style Vitest coverage under `ts/packages/runtime/tests/`

## Investigation Summary
- `openNativeStore()` opens file search through `openFileSearchDb(...)` and passes file-search/embedding configuration into the file-search stack.
- Current file-search scanning is synchronous and on-demand: `openFileSearchDb()` opens `byomem-file-search.sqlite`, ensures schema, creates a scheduler, and calls `handle.scanAndIndex()` once on open.
- Current scanner implementation is in `ts/packages/runtime/src/file-search-db.ts`:
  - `walkFiles(rootDir)` discovers files while honoring `.gitignore`
  - `scanAndIndexFiles(db, baseDir)` reads files, writes `scan_prefilter_events`, `content_hash_checks`, `file_records`, `indexed_files`, `indexed_chunks`, `changed_files`, and `reconciled_files`
  - deleted files are reconciled by comparing indexed rows to the current `seen` set
- Current scheduler status in `ts/packages/runtime/src/file-index-scheduler.ts` is limited to refresh metrics: `runs`, `failures`, `skips`, `retries`, `lastRunAt`, `lastFailureAt`.
- Sprint 32 added embedding diagnostics via `getEmbeddingDiagnostics()` and async `refreshSemanticIndex()`, but scan progress and file counts are still only inferable after a scan by querying SQLite tables.
- Current CLI has `file-search` for document search, but no dedicated scanner status command.
- Pi extension runtime status reports runtime/project/config details but does not currently include file-search scanner state, scheduler metrics, scan counts, last scan summary, or embedding diagnostics.
- The scanner is not currently a background process, so "files remaining" can only be reported during an active scan if the scanner records transient same-process progress in memory or writes a bounded status snapshot while scanning; a separate CLI process should be treated as reading the latest persisted snapshot unless cross-process live observation is deliberately implemented.
- Current mtime/size prefilter diagnostics should not be described as read avoidance: the scanner reads and hashes file content before deciding whether content changed. Counter names should avoid implying skipped reads unless implementation changes that behavior.
- Scanner trigger/source should be recorded where practical: `open`, `manual`, `scheduler-activation`, `scheduler-post-activity`, and `scheduler-backstop`.
- Binary/non-UTF8 read handling remains a scanner-hardening risk; Sprint 33 should report read/index errors accurately but should not broaden into a full binary-file indexing redesign.

## Acceptance Criteria
- AC-1: Runtime exposes a scanner status snapshot with explicit lifecycle state: `idle`, `running`, `completed`, `failed`, or `abandoned`.
- AC-2: Status includes scan timing fields: `runId`, `startedAt`, `completedAt`, `durationMs`, and `lastError` where applicable.
- AC-3: Status includes file progress counters with documented meanings: `discoveredFiles`, `scannedFiles`, `indexedFiles`, `unchangedFiles`, `changedFiles`, `deletedFiles`, `ignoredFiles`, `errorFiles`, `chunksWritten`, optional `bytesRead`, and `filesRemaining` when known.
- AC-4: Status includes the current/last file path being processed during a synchronous active scan where practical, without leaking ignored/internal paths.
- AC-5: Post-scan status includes DB counts for indexed files, indexed chunks, project keys, changed/reconciled rows, and semantic embedding coverage from Sprint 32 diagnostics.
- AC-6: Scanner status remains accurate after successful scans, no-op scans, changed-file scans, deleted-file reconciliation, and `.gitignore` exclusions.
- AC-7: Scanner failures are captured in status without corrupting existing index data, and `failed` status includes a useful `lastError`.
- AC-8: CLI exposes scanner status in stable JSON-friendly output and optional human-readable output, via either `file-search-status --base-dir ...` or `file-search --status --base-dir ...`.
- AC-9: The CLI can show status after a scan/search command has populated the DB, and it can show an initialized/empty status before any indexed files exist.
- AC-10: The implementation does not introduce watcher/daemon behavior, polling loops, or hidden async scanning; `scanAndIndex(): void` remains synchronous and status is final when it returns.
- AC-11: Existing Sprint 27–32 scanner/search/semantic behavior remains green.
- AC-12: Docs explain how to check scanner status, what counts mean, and the limitation that live progress is only visible during active synchronous operations or as the last persisted snapshot.
- AC-13: Scanner status is persisted only in the file-search DB, partitioned by `project_key`, and never touches memories DB or native snapshot storage.
- AC-14: Stale `running` scans are handled deterministically on the next scan/open/status read, e.g. by marking them `abandoned` or `failed` with a useful timestamp/error.
- AC-15: Scheduler-triggered refreshes update scanner status consistently with direct `scanAndIndex()` calls without expanding scheduler behavior into watcher semantics.
- AC-16: Status captures scan trigger/source where practical (`open`, `manual`, `scheduler-activation`, `scheduler-post-activity`, `scheduler-backstop`) without overpromising richer scheduler control-plane state.
- AC-17: Reading scanner status does not trigger semantic embedding refresh, background embedding work, or hidden async scanner work; embedding diagnostics may be co-reported only as read-only diagnostics.

## Execution Mode
standard

Rationale: the sprint is mostly centered on shared scanner/status surfaces in `file-search-db.ts`, CLI output in `cli.ts`, and focused tests. Parallel work would risk conflicts on the same files, so implementation should proceed in a serialized TDD flow. Documentation can proceed after the runtime/CLI shape is stable.

## Proposed Status Shape
Final names should be locked by RED tests before implementation, but the public shape should be close to:

```ts
export interface FileSearchScannerStatus {
  state: 'idle' | 'running' | 'completed' | 'failed' | 'abandoned';
  projectKey: string;
  baseDir: string;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  currentPath?: string;
  lastPath?: string;
  lastError?: string;
  trigger?: 'open' | 'manual' | 'scheduler-activation' | 'scheduler-post-activity' | 'scheduler-backstop';
  progress: FileSearchScannerProgress;
  database: FileSearchScannerDatabaseCounts;
  embeddings?: FileSearchEmbeddingDiagnostics;
}

export interface FileSearchScannerProgress {
  discoveredFiles: number;
  scannedFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  ignoredFiles: number;
  errorFiles: number;
  chunksWritten: number;
  bytesRead?: number;
  filesRemaining?: number;
}

export interface FileSearchScannerDatabaseCounts {
  indexedFiles: number;
  indexedChunks: number;
  changedRows: number;
  reconciledRows: number;
  projects: Array<{ projectKey: string; files: number }>;
}
```

Implementation notes:
- Prefer `getScannerStatus()` on `FileSearchDbHandle` plus exported public types.
- Persist compact latest-run status in `byomem-file-search.sqlite`, partitioned by `project_key`.
- Keep current/live progress minimal unless it can be observed synchronously without timers, watchers, polling, or async scanner lifecycle changes.
- If a persisted `running` run is stale, return/record `abandoned` or `failed` deterministically rather than leaving a permanent `running` status.

## Workstreams
- **WS-A: Status Core**
  - Paths: `ts/packages/runtime/src/file-search-db.ts`, possible status helper types/module
  - Focus: status snapshot shape, counters, lifecycle, DB count aggregation, embedding diagnostics integration

- **WS-B: CLI / Public Surface**
  - Paths: `ts/packages/runtime/src/cli.ts`, `ts/packages/runtime/src/index.ts`, CLI tests
  - Focus: `file-search-status` or `file-search --status`, JSON output, no background process assumptions

- **WS-C: Docs / Verification**
  - Paths: docs runbook/index/sprint docs
  - Focus: usage examples, count definitions, limitations, regression evidence

## Phases & Tasks
### Phase 0 — RED Tests / Contract Locking
- [ ] **0.1** Add failing scanner status shape tests in `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests for `idle`/`running`/`completed`/`failed`/`abandoned` status shape, run id, timing fields, DB counts, project key partitioning, and embedding diagnostics presence
  - Depends on: none
  - Verify: focused Sprint 33 test fails before status implementation

- [ ] **0.2** Add failing scan progress/counter tests in `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests proving discovered/scanned/indexed/unchanged/changed/deleted/ignored/error/chunks-written counters update across new, unchanged, changed, deleted, and `.gitignore`-ignored files with documented count semantics; include bytes-read assertions only if that counter is implemented deterministically
  - Depends on: 0.1
  - Verify: focused Sprint 33 test fails before counter implementation

- [ ] **0.3** Add failing failure-state and stale-running tests for scanner status
  - Role: test-engineer
  - Deliverable: RED tests proving scanner errors transition status to `failed`, preserve useful `lastError`, avoid corrupting already-indexed rows, and deterministically mark stale `running` snapshots as `abandoned` or `failed`
  - Depends on: 0.1
  - Verify: focused Sprint 33 test fails before error status implementation

- [ ] **0.4** Add failing CLI status tests in `ts/packages/runtime/tests/cli.test.ts` or a focused Sprint 33 CLI test
  - Role: test-engineer
  - Deliverable: RED tests for JSON status output from `file-search-status` or `file-search --status`, including initialized-empty and post-scan cases, without requiring users to run a search to inspect scanner status
  - Depends on: 0.1
  - Verify: CLI tests fail before status command implementation

- [ ] **0.5** Define the status contract in the sprint/test fixture comments
  - Role: planner + test-engineer
  - Deliverable: stable field names, lifecycle states, run id and trigger/source semantics, project partitioning, count definitions, stale-running behavior, and timing semantics used by tests and docs
  - Depends on: 0.1, 0.2
  - Verify: test expectations avoid overfitting to private scanner internals

### Phase 1 — Scanner Status Core
- [ ] **1.1** Add scanner status types and status state to file-search DB handle
  - Role: typescript-coder
  - Deliverable: exported scanner status interface, file-search DB status table, and `getScannerStatus()` API on `FileSearchDbHandle`
  - Depends on: 0.1
  - Verify: status shape tests pass

- [ ] **1.2** Instrument file discovery and scan/index counters
  - Role: backend-coder
  - Deliverable: scanner updates discovered/scanned/indexed/unchanged/changed/deleted/ignored/error/chunksWritten/currentPath/filesRemaining counters during `scanAndIndex()` using bounded/coarse writes rather than excessive per-line/per-chunk persistence; add `bytesRead` only if it is cheap and deterministic
  - Depends on: 1.1, 0.2
  - Verify: progress/counter tests pass for new/unchanged/changed/deleted/ignored scenarios

- [ ] **1.3** Add post-scan DB count aggregation
  - Role: backend-coder
  - Deliverable: status includes indexed file/chunk counts, project counts, changed/reconciled counts, and Sprint 32 embedding diagnostics
  - Depends on: 1.1
  - Verify: post-scan count tests pass and Sprint 32 embedding diagnostics tests remain green

- [ ] **1.4** Add failure-state and stale-running capture around scanner errors
  - Role: backend-coder
  - Deliverable: failed/abandoned lifecycle states, last error message, completion timestamp, stale-running recovery, and safe partial-status behavior on scanner failures
  - Depends on: 1.1, 0.3
  - Verify: failure-state tests pass

- [ ] **1.5** Keep scheduler refresh metrics compatible with scanner status
  - Role: backend-coder
  - Deliverable: scanner status and existing `refreshMetrics` coexist; scheduler-triggered refreshes call the same status-updating scan path and record trigger/source without changing Sprint 30 scheduler semantics
  - Depends on: 1.1, 1.4
  - Verify: Sprint 30/31 scheduler tests pass

### Phase 2 — CLI / Runtime Surface
- [ ] **2.1** Expose scanner status from public runtime exports
  - Role: typescript-coder
  - Deliverable: public type/export path for scanner status without private imports
  - Depends on: 1.1, 1.3
  - Verify: build/type checks pass and focused status tests import only public/runtime surfaces where practical

- [ ] **2.2** Add CLI status command or status flag
  - Role: typescript-coder
  - Deliverable: JSON-friendly scanner status output via `file-search-status --base-dir ...` or `file-search --status --base-dir ...`, with optional human-readable mode that does not destabilize JSON output
  - Depends on: 1.3, 0.4
  - Verify: CLI status tests pass

- [ ] **2.3** Add optional human-readable summary if low-risk
  - Role: builder
  - Deliverable: concise text summary only if it does not complicate JSON behavior; otherwise defer
  - Depends on: 2.2
  - Verify: CLI tests confirm JSON remains stable

- [ ] **2.4** Decide whether Pi extension runtime status should include scanner status
  - Role: backend-coder
  - Deliverable: either read-only scanner summary in `byomem_runtime_status()`/dedicated tool or an explicit documented deferral; do not trigger scans or embedding refresh from status reads
  - Depends on: 2.1
  - Verify: extension wiring tests pass if included, or sprint closeout records deferral

### Phase 3 — Docs / Regression / Closeout
- [ ] **3.1** Update scanner/document-search runbook with status examples
  - Role: documenter
  - Deliverable: docs explaining status command, field meanings, DB counts, embedding diagnostics, and live-progress limitations
  - Depends on: 2.2
  - Verify: docs review confirms examples match implementation

- [ ] **3.2** Run Sprint 27–33 file-search regression suite
  - Role: test-engineer
  - Deliverable: evidence that DB foundation, scanner/indexer, `.gitignore`, FTS, scheduler, semantic/hybrid search, and scanner status remain green
  - Depends on: 1.5, 2.2
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-27-file-search-db-foundation.test.ts ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`

- [ ] **3.3** Run full suite and build
  - Role: test-engineer
  - Deliverable: final sprint verification
  - Depends on: 3.1, 3.2
  - Verify: `npm test -- --run` and `npm run build`

- [ ] **3.4** Update docs index and roadmap references for Sprint 33
  - Role: documenter
  - Deliverable: `docs/README.md` and `docs/pi-memory-roadmap.md` link Sprint 33 in the file-search sequence
  - Depends on: sprint artifact creation
  - Verify: links resolve and docs index remains ordered

## Verification
- Focused Sprint 33 tests: `npm test -- --run ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`
- CLI status tests: `npm test -- --run ts/packages/runtime/tests/cli.test.ts`
- File-search regression across Sprints 27–33
- Regression that scanner status reads do not trigger semantic embedding refresh or hidden async scanner work
- Sprint 32 semantic/hybrid tests remain green
- Full suite: `npm test -- --run`
- Build: `npm run build`
- Manual smoke examples:
  - `node ts/packages/runtime/dist/cli.js file-search --base-dir . --mode fts --query "Sprint 33"`
  - `node ts/packages/runtime/dist/cli.js file-search-status --base-dir .`
  - Optional semantic status after `file-search --semantic-file-search --mode hybrid ...`

## Risks & Mitigations
- **Risk:** status work turns into a watcher/daemon, polling loop, hidden async scanner, or live TUI project.  
  **Mitigation:** explicitly keep Sprint 33 scoped to synchronous/on-demand status snapshots and a simple CLI/API surface.
- **Risk:** `filesRemaining` is misleading when discovery and scanning happen in one pass.  
  **Mitigation:** define it as known only after discovery count is available; use `undefined`/`null` or `0` with clear docs when not actively scanning.
- **Risk:** progress counters introduce performance overhead.  
  **Mitigation:** update in-memory counters cheaply and persist only bounded/coarse last-scan snapshots or aggregate counts, not per-line/per-chunk progress events.
- **Risk:** ignored/internal paths leak through `currentPath` or status details.  
  **Mitigation:** never expose ignored/internal paths; tests cover `.gitignore` and BYOMem DB exclusions.
- **Risk:** status snapshots become stale or remain `running` after a crash.  
  **Mitigation:** include timestamps and lifecycle state, and deterministically mark stale `running` snapshots as `abandoned` or `failed` on next scan/open/status read.
- **Risk:** failure tests require forcing scanner errors.  
  **Mitigation:** use controlled temp-file/permission or injectable test seam that does not affect production behavior.
- **Risk:** scanner status and scheduler refresh metrics diverge.  
  **Mitigation:** keep both surfaces distinct and document that scheduler metrics are refresh-trigger metrics while scanner status is scan/index progress.
- **Risk:** live progress is overpromised across processes.  
  **Mitigation:** document separate CLI status as latest persisted snapshot unless cross-process live observation is deliberately implemented and covered by tests.
- **Risk:** status work expands into binary-file indexing hardening.  
  **Mitigation:** report read/index errors accurately, but defer broad binary/non-UTF8 scanner redesign unless separately planned.

## Implementation Summary
- Added `FileSearchDbHandle.getScannerStatus()` with persisted status rows in `byomem-file-search.sqlite` table `file_search_scanner_status`.
- Added exported scanner status/progress types, scan run ids, trigger/source values, timing, counters, DB counts, and read-only embedding diagnostics.
- Instrumented synchronous `scanAndIndex()` while preserving the synchronous contract and avoiding watcher/daemon/polling behavior.
- Added stale `running` recovery to `abandoned` status and failed-scan status persistence.
- Added scheduler trigger/source plumbing for activation, post-activity, and backstop refreshes.
- Added `file-search-status --base-dir ... --json` CLI output with `scanner` and compatibility `status` fields; the status command disables open-time scanning and reads the latest persisted snapshot.
- Added Sprint 33 tests plus CLI coverage, including no hidden semantic refresh from status reads.
- Pi extension runtime-status inclusion is deferred; scanner status is available through the runtime handle and CLI without triggering scans beyond normal open-time indexing.

## Definition of Done
- [ ] Scanner status API exposes lifecycle, run id, trigger/source, project key, timing, counters, current/last path, DB counts, and read-only embedding diagnostics.
- [ ] Status is test-covered for idle/completed/failed states and new/changed/deleted/ignored file scenarios.
- [ ] CLI status command/flag returns stable JSON output.
- [ ] No watcher, daemon, polling loop, fire-and-forget task, or background scanner behavior is introduced.
- [ ] Existing refresh metrics remain compatible, and scheduler-triggered scans update scanner status consistently.
- [ ] Sprint 27–32 file-search behavior remains green.
- [ ] Full test suite and build pass.
- [ ] Docs/runbook explain status fields, examples, and limitations.
- [ ] Independent review confirms the status/progress surface is accurate, bounded, and does not leak ignored/internal paths.

## See Also
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-30-file-index-scheduler-and-hardening.md`
- `docs/sprint-31-file-search-refinement-and-cleanup.md`
- `docs/sprint-32-semantic-hybrid-document-search.md`
- `docs/semantic-hybrid-document-search-runbook.md`
- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/file-index-scheduler.ts`
- `ts/packages/runtime/src/cli.ts`
- `ts/packages/runtime/src/index.ts`
- `ts/packages/runtime/src/pi-extension.ts`
