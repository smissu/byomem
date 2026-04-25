# Sprint 34: File Search Scan Command

## Objective
Add an explicit CLI command for refreshing the BYOMem file-search index without requiring a document search query. The command uses the existing synchronous scanner, returns the same scanner status shape introduced in Sprint 33, and avoids watchers, daemons, polling, or semantic embedding refresh side effects.

## Scope
### In scope
- Add `file-search-scan` to the runtime CLI command list.
- Open file-search for the scan command without scan-on-open so the command itself owns the refresh.
- Invoke the existing synchronous `scanAndIndex()` path and return JSON containing `scanner` and `status` aliases.
- Preserve `file-search-status` as a read-only command that does not scan on open.
- Add CLI regression coverage for query-free scans, changed/deleted counters, and no embedding-server requirement.

### Out of scope
- Watcher/daemon behavior, polling loops, or background refresh tasks.
- New semantic search or embedding behavior.
- Rich terminal progress UI.
- Scheduler redesign.

## Investigation Summary
- Sprint 33 already exposes `FileSearchDbHandle.getScannerStatus()` and persists scanner status in the file-search DB.
- `file-search-status` opens the native store with `fileSearchScanOnOpen: false`, proving status can be read without starting a scan.
- The CLI previously had no explicit scan-only command; users had to rely on scan-on-open from `file-search` or runtime opening.
- The safest implementation is to share the same `scanAndIndex()` method and status output rather than adding a second indexing path.

## Acceptance Criteria
- [x] AC34-1: `file-search-scan --base-dir <dir>` indexes files without a query and prints JSON containing `scanner`/`status` with `state: completed`, `trigger: manual`, and indexed counts.
- [x] AC34-2: Running scan after a file change/deletion updates changed/deleted counters and DB counts.
- [x] AC34-3: `file-search-status` remains read-only and does not scan on open.
- [x] AC34-4: The command does not call `refreshSemanticIndex()` or require an embedding server.
- [x] AC34-5: Usage/help includes `file-search-scan`.

## Execution Mode
standard

Rationale: the command is a small CLI/API surface over shared scanner state; implementation and tests touch shared `cli.ts` and should remain serialized.

## Phases & Tasks
### Phase 0 — RED Tests / Contract Locking
- [x] **0.1** Add failing CLI usage coverage for `file-search-scan`.
  - Role: test-engineer
  - Deliverable: CLI help/usage includes the command.
  - Verify: focused CLI test fails before usage update.
- [x] **0.2** Add failing query-free scan coverage.
  - Role: test-engineer
  - Deliverable: CLI test proves scan command indexes files and returns manual completed status without a query.
  - Verify: focused CLI test fails before command implementation.
- [x] **0.3** Add failing changed/deleted counter coverage.
  - Role: test-engineer
  - Deliverable: CLI test proves repeated explicit scans update changed/deleted status counters.
  - Verify: focused CLI test fails before command implementation.

### Phase 1 — CLI Implementation
- [x] **1.1** Add `file-search-scan` to usage and file-search command classification in `ts/packages/runtime/src/cli.ts`.
  - Role: typescript-coder
  - Verify: CLI usage test passes.
- [x] **1.2** Open the store with `fileSearchScanOnOpen: false` for scan command execution.
  - Role: typescript-coder
  - Verify: scan output trigger is `manual`, not `open`.
- [x] **1.3** Invoke `scanAndIndex()` and return stable JSON status aliases.
  - Role: typescript-coder
  - Verify: query-free scan and changed/deleted tests pass.

### Phase 2 — Docs / Regression
- [x] **2.1** Update docs index, roadmap, and runbook with `file-search-scan` usage.
  - Role: documenter
  - Verify: docs match CLI command/output.
- [x] **2.2** Run focused Sprint 33/34 CLI regression.
  - Role: test-engineer
  - Verify: `npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`.

## Verification
- `npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts` — passed, 2 files / 21 tests.

## Definition of Done
- [x] Explicit scan command is implemented and test-covered.
- [x] Status command remains read-only.
- [x] No watcher, daemon, polling, or semantic refresh behavior was introduced.
- [x] Sprint docs and roadmap/index links are updated.
