# Sprint 43: Runtime-Local File-Search Async Scan Jobs

## Objective

Add a small, explicit runtime-local async scan layer for BYOMem file-search scanning so Pi/runtime callers can request a scan, receive a `job_id` immediately, and inspect in-process job progress while preserving the existing synchronous `scanAndIndex()` behavior and without changing the existing BYOMem queue system.

This sprint is intentionally **not** a durable DB queue/lease sprint. Cross-process scan orchestration, persistent scan-job rows, stale lease recovery, detached CLI workers, and file-search DB queue semantics are deferred until a future sprint proves they are needed.

## Scope

### In Scope

- Preserve the existing synchronous scanner and default synchronous scan behavior.
- Add a process-local scan manager/dispatcher for runtime/Pi-hosted async scans.
- Return a stable in-process `job_id` for async scan requests.
- Track active and recent in-memory scan jobs with state/progress/error metadata.
- Prevent duplicate same-project async scans in the same runtime process by returning the active job id.
- Use a simple runtime-local global concurrency limit of `1` scan at a time by default.
- Expose async scan enqueue and in-process job/status lookup through Pi direct tools.
- Keep CLI scan behavior synchronous by default; if an async CLI flag is added, it must fail deterministically as unsupported/no active runtime worker rather than creating hidden background work.
- Add TDD-first tests for manager behavior, Pi tool contracts, sync compatibility, and status read-only behavior.
- Document that async jobs are runtime-local and disappear on process restart.

### Out of Scope

- Do not change the existing BYOMem DB/JSON queue system.
- Do not add durable file-search scan-job tables in Sprint 43.
- Do not add DB-backed leases, heartbeat stale recovery, or cross-process scan ownership.
- Do not add detached CLI worker process management.
- Do not provide cross-process concurrency guarantees beyond the existing SQLite/scanner safety behavior.
- Do not redesign the scanner's file discovery/chunking/indexing algorithm.
- Do not replace semantic embedding refresh with a background embedding job system.
- Do not add filesystem watchers or long-running OS daemons.
- Do not change search ranking, BM25, semantic search, or line-range behavior from Sprint 42.
- Do not make polling globally automatic by default.

## Investigation Summary

Current behavior from repo and project memory:

- File-search scanning is currently synchronous/on-demand.
- `scanAndIndex()` remains synchronous and direct scan tools return after completion.
- Scanner status/progress snapshots already exist from Sprint 33 and are persisted per `project_key`.
- `file-search-status` and `byomem_file_search_status` are read-only status paths and do not scan.
- Direct Pi `byomem_file_search_scan` performs one manual scan and returns scanner/status results.
- The file-search DB is global/shared by default, with logical partitions by `project_key`.
- Same-process scan calls effectively serialize today because scanner work uses synchronous file/SQLite operations.
- Cross-process DB-backed queue/lease coordination is deliberately deferred from this sprint.
- Active-project polling is session-owned and single-active-project-oriented; it is not a global multi-project scan queue.

Relevant implementation surfaces:

- `ts/packages/runtime/src/file-search-db.ts`
  - synchronous scanner core, persisted scanner status, project key, DB schema
- New focused module such as `ts/packages/runtime/src/file-search-scan-manager.ts`
  - runtime-local async job manager and in-memory job registry
- `ts/packages/runtime/src/pi-extension.ts`
  - `byomem_file_search_scan`, `byomem_file_search_status`, potential job-status surface
- `ts/packages/runtime/src/cli.ts`
  - preserve synchronous `file-search-scan`; optionally reject async CLI mode deterministically
- Existing tests to preserve/extend:
  - Sprint 33 scanner status tests
  - Sprint 38 direct Pi file-search tool tests
  - Sprint 39 active-project polling tests where relevant
  - CLI tests around file-search scan/status

Current repo-state gate:

- Sprint 42 line-range implementation files are currently present in the working tree. Sprint 43 implementation should start only after the current working tree state is committed, reverted, or explicitly adopted as the Sprint 43 baseline.

## Acceptance Criteria

- **AC-1:** Given a runtime/Pi caller requests async file-search scan, when `{ async: true }` or equivalent is passed, then the call returns a stable runtime-local `job_id` before the scan completes.
- **AC-2:** Given existing callers use `scanAndIndex()` or default `byomem_file_search_scan`, when they do not request async mode, then scan behavior remains synchronous and backward compatible.
- **AC-3:** Given a job is active in the current runtime process, when status is requested by `job_id` or project, then the caller receives `job_id`, `project_key`, `base_dir`, `state`, `trigger`, `queued_at`, `started_at`, `completed_at`, `error`, and latest scanner progress/status snapshot available in-process.
- **AC-4:** Given an async scan is already queued or running for a project in the current process, when a second same-project async request arrives, then it returns the active job id and does not start a duplicate same-project scan.
- **AC-5:** Given async scans are requested for different projects in the same runtime process, when the default concurrency limit is `1`, then jobs are queued/executed serially in-process and each project receives a distinct job id.
- **AC-6:** Given the runtime process exits or restarts, when job status is requested later, then in-memory async job history is not assumed durable; docs and responses make this runtime-local limitation clear.
- **AC-7:** Given `file-search-status` or `byomem_file_search_status` is called, when no scan is requested, then status lookup remains read-only and does not start indexing or semantic refresh.
- **AC-8:** Given CLI users run `file-search-scan` without async flags, when the command executes, then existing synchronous behavior is preserved.
- **AC-9:** Given CLI users request async scan in Sprint 43, when no active runtime job bridge exists, then the CLI fails deterministically with a documented unsupported/no-active-runtime-worker error rather than creating hidden background work.
- **AC-10:** Existing Sprint 33/36/37/38/39/41/42 scan/status/global-DB/project-registry/polling/file-search behavior remains green.

## Proposed Contract

Default compatibility posture:

- Existing direct scan behavior remains synchronous by default.
- `scanAndIndex()` remains synchronous and is not converted into a queue API.
- The existing BYOMem queue system is unchanged.

Runtime-local async contract:

- Add a small runtime-local scan manager, for example `FileSearchScanManager`, owned by the runtime/Pi extension host.
- Async jobs live in memory only and are scoped to the current process.
- Default runtime-local concurrency is `1` active scan at a time.
- Same-project duplicate policy: if a job is `queued` or `running` for the same `project_key`, return that active job id.
- Recent completed/failed jobs may be retained in a bounded in-memory history for status/debugging, but are not persisted across restart.
- Job states: `queued`, `running`, `completed`, `failed`.
- Terminal jobs (`completed`, `failed`) do not block later enqueue attempts.

Pi direct tool contract:

- `byomem_file_search_scan` keeps synchronous behavior by default.
- `byomem_file_search_scan({ async: true })` or `byomem_file_search_scan({ wait: false })` enqueues work in the runtime-local scan manager and returns immediately with job metadata.
- `byomem_file_search_status` may include active/recent runtime-local job metadata for the project without starting a scan.
- Either `byomem_file_search_status` accepts an optional `jobId`, or a small dedicated job-status tool is added; the chosen public shape must be locked by tests.

CLI contract:

- `file-search-scan` remains synchronous by default.
- Sprint 43 does not add detached CLI workers.
- If `file-search-scan --async` is accepted syntactically, it returns a deterministic documented error such as `async-scan-runtime-local-only` or `no-active-runtime-worker` unless/until a future sprint adds a runtime bridge.
- CLI status remains read-only and reports persisted scanner status, not in-memory jobs from another process.

Example async enqueue response:

```json
{
  "job": {
    "job_id": "runtime-scan-...",
    "project_key": "project:example",
    "base_dir": "/path/to/project",
    "state": "queued",
    "trigger": "manual",
    "queued_at": "...",
    "started_at": null,
    "completed_at": null,
    "error": null,
    "durable": false
  },
  "scanner": { "state": "idle", "progress": {} }
}
```

## RED Test Coverage Details

The RED test pass should explicitly lock these behaviors before implementation:

1. **Runtime-local manager behavior**
   - Async enqueue returns a `job_id` before scan completion using a controlled slow-scanner/test hook or deferred promise instead of wall-clock timing.
   - Same-project duplicate async requests return the active job id and do not invoke the scan runner twice.
   - Different-project async requests receive distinct job ids and execute serially with concurrency `1`.
   - Completed/failed jobs become terminal and do not block future enqueue attempts.
   - Failed jobs retain useful in-memory error diagnostics.

2. **Sync compatibility**
   - Existing `scanAndIndex()` remains synchronous and returns completed scanner status.
   - Default Pi `byomem_file_search_scan` behavior remains synchronous.
   - Existing CLI `file-search-scan` behavior remains synchronous.

3. **Status behavior**
   - Status by `job_id` returns active/recent in-process job metadata.
   - Project status can include active/recent in-process job metadata when available.
   - Status reads are side-effect-free: no scan starts, no files are indexed, and no semantic refresh is triggered by status-only calls.
   - Runtime-local limitation is observable/documented: unknown/expired job ids return a deterministic not-found/runtime-local response.

4. **Pi and CLI contracts**
   - Pi direct scan tool supports explicit async mode with strict schema and no hidden default behavior change.
   - Pi status path reports runtime-local job progress without starting a scan.
   - CLI async flag, if present, returns deterministic unsupported/no-active-runtime-worker response and does not enqueue durable jobs or spawn workers.

Prefer a new Sprint 43-specific test file where practical, especially for the runtime-local manager. Update existing CLI and Pi extension tests only where needed to lock public contracts.

## Execution Mode

**Standard / mostly serial.**

Rationale: this sprint is intentionally smaller than the original durable-job design, but it still touches shared scan/status tool contracts. Implement the runtime-local manager first, then wire Pi tools, then add CLI/docs hardening.

## Phases & Tasks

### Phase 0 — Preflight and RED Tests

- [ ] **0.1** Confirm baseline and overlapping active work.
  - Role: `codebase-investigator`
  - Deliverable: short note confirming whether Sprint 42 line-range work is committed, reverted, or explicitly accepted as the Sprint 43 baseline.
  - Gate: if Sprint 42 changes or unrelated dirty files remain, stop Sprint 43 implementation until the user explicitly commits, reverts, or declares them the Sprint 43 baseline.
  - Depends on: none
  - Verify:
    ```bash
    git status --short
    ```

- [ ] **0.2** Add RED tests for runtime-local scan manager enqueue/status behavior.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts`
  - Deliverable: failing tests for pre-completion `job_id` return, same-project duplicate policy, different-project serial execution with concurrency `1`, terminal job behavior, failed-job diagnostics, and status-by-`job_id`.
  - Depends on: 0.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **0.3** Add RED tests for sync compatibility.
  - Role: `test-engineer`
  - Files: `ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts`, existing scanner/CLI/Pi tests where needed
  - Deliverable: failing or guard tests proving `scanAndIndex()`, default `byomem_file_search_scan`, and default `file-search-scan` remain synchronous/backward compatible.
  - Depends on: 0.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

- [ ] **0.4** Add RED Pi/CLI contract tests.
  - Role: `test-engineer`
  - Files: `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`, `ts/packages/runtime/tests/cli.test.ts`, Sprint 43 test file as needed
  - Deliverable: failing tests for Pi async enqueue response, Pi status/job lookup without scanning, and deterministic CLI async unsupported/no-active-runtime-worker behavior if an async CLI flag is exposed.
  - Depends on: 0.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

### Phase 1 — Runtime-Local Scan Manager

- [ ] **1.1** Add runtime-local scan manager module.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-scan-manager.ts`
  - Deliverable: process-local manager with `enqueueScan`, `getJob`, project active/latest lookup, bounded recent history, states `queued|running|completed|failed`, same-project duplicate policy, and concurrency limit `1`.
  - Depends on: 0.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **1.2** Wire manager to existing synchronous scanner without changing `scanAndIndex()`.
  - Role: `typescript-coder`
  - Files: `ts/packages/runtime/src/file-search-scan-manager.ts`, `ts/packages/runtime/src/file-search-db.ts` only if a small exported helper/type is needed
  - Deliverable: async manager executes the existing synchronous scan path in a scheduled task while preserving default synchronous API behavior.
  - Depends on: 1.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **1.3** Add status snapshot composition for in-memory jobs.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-scan-manager.ts`
  - Deliverable: job status includes job metadata plus latest available scanner status/progress, and returns deterministic not-found/runtime-local responses for unknown or expired job ids.
  - Depends on: 1.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

### Phase 2 — Pi Extension Wiring

- [ ] **2.1** Add Pi direct tool async scan option.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/pi-extension.ts`
  - Deliverable: `byomem_file_search_scan` remains synchronous by default and supports explicit runtime-local async mode returning job metadata when requested.
  - Depends on: 1.3
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **2.2** Add Pi status/job lookup surface.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/pi-extension.ts`
  - Deliverable: `byomem_file_search_status` includes active/recent runtime-local job metadata or accepts `jobId`, or a dedicated job-status tool is added; status remains read-only.
  - Depends on: 2.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

### Phase 3 — CLI Guardrails, Docs, and Regression

- [ ] **3.1** Preserve CLI synchronous behavior and reject async CLI ambiguity.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/cli.ts`
  - Deliverable: `file-search-scan` remains synchronous. If `--async` is added/accepted, it returns a deterministic unsupported/no-active-runtime-worker error and never spawns a worker or enqueues durable work.
  - Depends on: 1.3
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **3.2** Update docs/runbook for runtime-local async scans.
  - Role: `documenter`
  - Files: `docs/semantic-hybrid-document-search-runbook.md`, `docs/README.md`, `docs/pi-memory-roadmap.md`
  - Deliverable: document sync default, runtime-local async Pi mode, in-memory job status, process-restart limitation, CLI non-detached/unsupported behavior, and future durable queue/lease deferral.
  - Depends on: 2.2, 3.1
  - Verify: docs mention runtime-local async scans and explicitly say no durable DB queue/lease is added in Sprint 43.

- [ ] **3.3** Run file-search regression slice.
  - Role: `test-engineer`
  - Deliverable: Sprint 33/36/37/38/39/41/42/43 file-search/global-DB/project-registry tests pass together.
  - Depends on: 3.2
  - Verify:
    ```bash
    cd <PROJECT_ROOT>
    npm test -- --run \
      ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
      ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts \
      ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts \
      ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts \
      ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts \
      ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts \
      ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts \
      ts/packages/runtime/tests/sprint-43-file-search-async-scan-jobs.test.ts
    ```

- [ ] **3.4** Run full validation and review.
  - Role: `builder`, `code-reviewer`
  - Deliverable: build/test suite passes and code review confirms Sprint 43 did not introduce durable queue/lease behavior or async CLI background workers.
  - Depends on: 3.3
  - Verify:
    ```bash
    cd <PROJECT_ROOT>
    npm test -- --run
    npm run build
    git diff --check
    ```

## Risks & Mitigations

- Risk: runtime-local async jobs are mistaken for durable background jobs. -> Mitigation: response includes `durable: false`; docs and errors state jobs are in-memory and process-local.
- Risk: CLI users expect async scan to continue after process exit. -> Mitigation: CLI remains synchronous by default and rejects async ambiguity deterministically in Sprint 43.
- Risk: same-project duplicate scans race inside one runtime. -> Mitigation: process-local manager returns the active job id and does not start a duplicate same-project scan.
- Risk: runtime-local queue hides scanner failures. -> Mitigation: failed jobs retain in-memory diagnostics and status shows scanner error details.
- Risk: scope expands back into durable queue/lease work. -> Mitigation: durable scan-job tables, DB leases, stale recovery, detached workers, and cross-process guarantees are explicitly out of scope and reserved for a future sprint.

## Future Sprint Candidates

If runtime-local async scans prove useful and durable operation becomes necessary, plan a separate sprint for:

- durable file-search scan-job table;
- DB-backed lease/heartbeat and stale recovery;
- cross-process concurrency guarantees;
- detached or supervised CLI workers;
- job history retention and admin cleanup commands.

## Definition of Done

- [ ] Runtime/Pi async scan enqueue returns a stable runtime-local `job_id` before scan completion.
- [ ] Existing synchronous `scanAndIndex()`, default Pi scan, and default CLI scan behavior remain compatible.
- [ ] Same-project runtime-local async duplication is prevented by tested policy.
- [ ] Different-project runtime-local async scans are serialized by concurrency limit `1`.
- [ ] Job status/progress is readable in-process without starting scans.
- [ ] CLI async ambiguity is rejected deterministically or left unsupported; no detached worker is added.
- [ ] No durable scan-job DB table, DB lease system, or BYOMem queue-system change is introduced.
- [ ] Sprint 33/36/37/38/39/41/42/43 regression tests pass.
- [ ] Full tests, build, and `git diff --check` pass.
- [ ] Independent review signs off that the sprint stayed within runtime-local async scope.
