# Sprint 25: TS Memory Processing Observer

## Objective
Add a TypeScript-native memory-processing observer that gives operators a compact, read-only view of queue/runtime state from the active BYOMem TS pipeline. The observer should replace the old Python-oriented queue-status workflow for supported native runtime usage while staying aligned with the queue-first single-writer architecture established in prior sprints.

## Background / Prior Context
Historically, queue observability lived in the Python CLI and shell wrapper:
- `cli.py queue` reported queue counts and worker-lock state by inspecting Python queue artifacts such as `pending/`, `processing/`, `failed/`, and `worker.pid`
- `monitor-queue.sh` wrapped that command with `watch` for polling-based terminal monitoring

Current operator guidance prefers the TS-native observer path:
- `queue-observe` provides the supported read-only snapshot surface
- `queue-observe --watch` is the default active monitoring workflow for terminal observation
- Any retained `monitor-queue.sh` usage should be treated as legacy/dev-only or non-default

That behavior was useful operationally, but it reflected the old Python queue model described in `docs/pipeline-architecture.md`, where queue processing flowed through Python worker/job directories and process-level PID lock state.

Since Sprints 21, 23, and 24, the active/default runtime path is TypeScript-native:
- Sprint 21 moved session capture and queue runtime behavior onto the TS path
- Sprint 23 established the TS-native runtime as the default steady-state path and pushed Python to offline/dev-only or disabled-by-default compatibility roles
- Sprint 24 clarified the queue-first single-writer architecture, global physical store, logical partitioning, and public-surface hardening

The current TS runtime uses snapshot-style queue/worker artifacts rather than Python queue directories:
- `ts/packages/runtime/src/queue.ts` persists queue jobs in `queue.json`
- `ts/packages/runtime/src/worker.ts` persists worker state in `worker.json`
- `ts/packages/runtime/src/queue-runtime.ts` coordinates capture/write/replay through the queue-backed runtime and worker lock/offset model

This sprint closes the remaining observability gap by introducing a TS-native memory-processing observer over the active runtime artifacts rather than relying on the old Python `queue` command semantics.

## Scope
### In scope
- Add a TS-native read-only observer for queue/worker state from the active runtime artifacts
- Expose compact text output for humans and JSON output for tooling
- Surface queue job counts by TS-native state: `queued`, `checkpointed`, and `flushed`
- Surface worker state: `workerId`, `sessionId`, `offset`, and `lock`
- Show bounded recent-job/history output
- Add derived health hints based on current queue/worker snapshot state
- Add targeted tests for empty state, populated state, restart-safe state, and JSON/text output
- Wire the observer into the supported TS command surface for one-shot snapshot inspection

### Out of scope
- Recreating Python queue semantics exactly when they do not map to TS-native state
- Mutation features such as purge, retry, fail, or repair
- Reintroducing Python as the active observability surface
- TS-native `--watch` / auto-refresh support, which is deferred to `docs/sprint-26-ts-memory-processing-observer-watch-mode.md`
- Full metrics/telemetry streaming or external dashboards
- Multi-process liveness detection beyond the current TS worker snapshot model
- Redesigning queue persistence or worker lifecycle behavior beyond what is needed for observation

## Non-goals
- Replacing deeper telemetry/metrics work that may follow later
- Introducing queue recovery actions in the same sprint
- Reworking session capture, write semantics, or store schema
- Supporting unsupported or legacy direct-write or Python-first runtime paths as first-class observer targets

## Dependencies
- `docs/sprint-21-ts-session-capture-and-queue-runtime-migration.md`
- `docs/sprint-23-ts-runtime-cutover-legacy-retirement-and-documentation-closure.md`
- `docs/sprint-24-global-store-project-partitioning-queue-first-single-writer.md`
- `docs/session-memory-native-architecture.md`
- `docs/pipeline-architecture.md`
- Current runtime modules:
  - `ts/packages/runtime/src/queue.ts`
  - `ts/packages/runtime/src/worker.ts`
  - `ts/packages/runtime/src/queue-runtime.ts`
- Existing runtime coverage:
  - `ts/packages/runtime/tests/queue-runtime.test.ts`

## Investigation Summary
- The old operational UX came from Python `cli.py queue` plus `monitor-queue.sh`
- The active TS runtime now persists queue and worker snapshots in `queue.json` and `worker.json`
- The TS queue state model is job-based and currently uses `queued`, `checkpointed`, and `flushed`
- Worker state is snapshot-based and includes `workerId`, `sessionId`, `offset`, and `lock`
- Existing tests already validate runtime queue persistence and restart behavior in `ts/packages/runtime/tests/queue-runtime.test.ts`
- The observer should reflect TS-native state honestly rather than force a misleading Python `pending/processing/failed` translation
- The implementation should be additive and read-only, with no queue mutation in this sprint

## Acceptance Criteria
- AC-1: A supported TS command can read the active runtime’s queue and worker snapshot state without mutating it.
- AC-2: Text output shows worker state, queue summary, health hints, and bounded recent jobs in a compact operator-friendly format.
- AC-3: JSON output returns the same observer data in a stable machine-readable shape.
- AC-4: Missing queue/worker files are handled gracefully and produce sensible empty/default observer output rather than hard failure.
- AC-5: The observer reports TS-native queue states (`queued`, `checkpointed`, `flushed`) rather than obsolete Python directory-state terminology.
- AC-6: Tests cover empty state, populated queue state, restart/reopen state, and output-shape correctness.
- AC-7: The supported/default observability path for queue inspection does not require invoking Python.

## Execution Mode
Standard.

Rationale: this is a narrow but shared-surface runtime/CLI/documentation slice; the command shape, observer model, and tests are tightly coupled and best landed in a single controlled sequence.

## Phases & Tasks
### Phase 0 — Observer contract and failing tests
- [ ] **0.1** Add failing observer tests in `ts/packages/runtime/tests/queue-observer.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests covering empty state, populated queue state, bounded recent history, and JSON/text output.
  - Depends on: none
  - Verify: `vitest run ts/packages/runtime/tests/queue-observer.test.ts`

- [ ] **0.2** Define observer snapshot/summary types in `ts/packages/runtime/src/queue-observer.ts` or an adjacent observer-types module
  - Role: typescript-coder
  - Deliverable: explicit types for worker summary, queue summary, recent jobs, and health hints.
  - Depends on: 0.1
  - Verify: tests compile against the intended observer contract

### Phase 1 — Core observer implementation
- [ ] **1.1** Implement read-only queue/worker snapshot loading and summary derivation in `ts/packages/runtime/src/queue-observer.ts`
  - Role: typescript-coder
  - Deliverable: observer logic that reads runtime state via existing queue/worker interfaces and derives counts, recent jobs, and health indicators.
  - Depends on: 0.1, 0.2
  - Verify: `vitest run ts/packages/runtime/tests/queue-observer.test.ts ts/packages/runtime/tests/queue-runtime.test.ts`

- [ ] **1.2** Implement compact text rendering and stable JSON shaping in `ts/packages/runtime/src/queue-observer-format.ts` or equivalent formatting helpers
  - Role: typescript-coder
  - Deliverable: human-readable and machine-readable output formatting for the observer.
  - Depends on: 1.1
  - Verify: observer tests assert text sections and JSON shape

### Phase 2 — Command wiring and UX
- [ ] **2.1** Wire the observer into the supported TS command surface with text and JSON output flags
  - Role: builder
  - Deliverable: command entrypoint exposing the TS observer to users.
  - Depends on: 1.1, 1.2
  - Verify: targeted CLI/integration test or command smoke run against a temp `--base-dir`

- [ ] **2.2** Add bounded `--history <n>` support for recent-job output in the TS observer command
  - Role: builder
  - Deliverable: bounded recent-history output without introducing queue mutation or watch-mode behavior.
  - Depends on: 2.1
  - Verify: targeted command tests or manual smoke checks for history truncation

### Phase 3 — Documentation and cleanup
- [ ] **3.1** Update `docs/` references to point queue inspection guidance at the TS-native observer path
  - Role: documenter
  - Deliverable: concise operator guidance aligned with the native runtime architecture.
  - Depends on: 2.1
  - Verify: docs review confirms queue inspection guidance points to the TS-native path

- [ ] **3.2** Clarify the status of `monitor-queue.sh` as legacy/dev-only or non-default if retained
  - Role: documenter
  - Deliverable: explicit documentation or comments removing ambiguity about the supported observer workflow.
  - Depends on: 3.1
  - Verify: no docs ambiguity remains about the default queue-observer path

## Verification
- RED-first:
  - `vitest run ts/packages/runtime/tests/queue-observer.test.ts`
- Core runtime regression:
  - `vitest run ts/packages/runtime/tests/queue-runtime.test.ts`
  - `vitest run ts/packages/runtime/tests/runtime-mode.test.ts`
- If command wiring lands in an existing CLI surface:
  - run the repo’s targeted TS command/integration test for the new observer command
- Manual smoke:
  - invoke the observer with `--base-dir <tempdir>` against fixture or test-generated `queue.json` and `worker.json`
  - verify text output contains Worker, Queue Summary, Health, and Recent Jobs in one-shot snapshot mode
  - verify JSON output contains worker state, queue counts, recent jobs, and health hints
- Behavioral checks:
  - empty base dir returns graceful empty/default output
  - populated queue returns accurate counts for `queued`, `checkpointed`, and `flushed`
  - reopened runtime state returns consistent worker snapshot and recent-job output
  - no observer command path mutates queue or worker artifacts

## Risks & Open Questions
- Risk: the current TS command host for adding a new observer command may not yet be obvious or centralized.
  - Mitigation: attach the observer to the existing supported TS entrypoint rather than creating a parallel CLI surface.

- Risk: Python queue terms (`pending`, `processing`, `failed`) do not map cleanly to TS-native queue job states.
  - Mitigation: expose TS-native states directly and document the behavior change explicitly.

- Risk: true worker liveness cannot be inferred from `worker.json` alone the way `worker.pid` attempted to in Python.
  - Mitigation: report snapshot/lock state honestly in MVP and defer heartbeat/PID-grade liveness to later work if needed.

- Risk: timestamp-based backlog-age hints may be noisy if `createdAt` is missing or malformed.
  - Mitigation: make age-based hints best-effort and optional rather than a correctness requirement.

- Open question: Sprint 26 should decide whether `--watch` is text-only in its first iteration or whether any repeated JSON mode is needed later.
- Open question: whether the user-facing command should remain `queue` for continuity or use a more explicit alias while preserving compatibility.

## Definition of Done
- [ ] A TS-native read-only memory-processing observer exists on the supported runtime path for one-shot snapshot inspection
- [ ] Text output shows worker state, queue summary, health hints, and recent jobs
- [ ] JSON output shape is stable and tested
- [ ] Empty or missing runtime state is handled gracefully
- [ ] Observer tests are green in the runtime package
- [ ] Queue inspection guidance points to the TS-native observer rather than Python as the default path
- [ ] Any retained Python queue-monitoring utility is clearly documented as legacy/dev-only or non-default
- [ ] The sprint doc and implementation artifacts are sufficient for the next coding step to begin directly from this plan
