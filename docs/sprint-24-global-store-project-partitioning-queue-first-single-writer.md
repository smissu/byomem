# Sprint 24: Global Physical Store, Logical Project Partitioning, and Queue-First Single-Writer BYOMem

## Objective
Establish a single global physical BYOMem store backed by one SQLite owner process, with logical partitioning for project and user memory and a queue-first write boundary. This sprint makes the storage/runtime architecture explicit, observable, and migration-ready so all writes flow through one durable queue into a single writer while read/query behavior remains partition-aware. It also locks the partition-key, writer-ownership, and migration semantics before implementation starts.

## Scope
### In scope
- One global physical store for all BYOMem data
- Logical partitioning for project-scoped and user-scoped memory within the store
- Queue as the only write boundary into the store
- Single writer process owning SQLite writes and serialization
- Canonical project-identity derivation, normalization, collision handling, and routing
- Migration, shadow verification, and rollback semantics for schema/data movement
- Writer lifecycle handling for lock ownership, crash recovery, duplicate prevention/idempotency, and partial checkpoint/flush cases
- Observability for queue depth, queue latency, backlog age, summarizer capacity decisions, and failure/backpressure paths
- Lessons learned from the old Python queue architecture applied to the TypeScript runtime path
- Migration notes and documentation updates for the new architecture

### Out of scope
- Multi-writer SQLite access
- Sharding into multiple physical stores
- Full data-model redesign beyond partitioning and writer boundaries
- New retrieval/ranking features unrelated to the store/queue boundary
- External service dependencies beyond the current local runtime and queue/store components

## Investigation Summary
- Relevant files: current runtime/store/queue modules, adapter/runtime integration points, docs/sprint-21 through docs/sprint-23 for recent migration context, and legacy Python queue implementation references
- Key dependencies: SQLite ownership model, queue consumer lifecycle, summarizer throughput/capacity policy, and store routing by memory scope
- Known findings to carry forward:
  - use one global physical store rather than per-project physical databases
  - keep project and user memory logically partitioned inside the store
  - route writes through a queue that forms the write boundary
  - keep a single writer as the exclusive SQLite owner
  - expose queue depth, queue latency, backlog age, and summarizer capacity decisions as first-class observability signals
  - preserve the useful parts of the old Python queue design while avoiding its operational pitfalls
- Risks/unknowns: exact module boundaries for the current queue/runtime implementation, schema details for partition metadata, and whether any adapter code still assumes local write access

## Acceptance Criteria
- AC-1: All writes to BYOMem storage go through a queue and are handled by one writer process that exclusively owns SQLite access.
- AC-2: The store persists project-scoped and user-scoped memory in one global physical database while keeping logical partition boundaries intact and queryable.
- AC-3: Canonical project identity is derived, normalized, collision-checked, and used consistently for routing and lookup.
- AC-4: Schema/data migration, shadow verification, and rollback behavior are defined and validated before cutover.
- AC-5: Writer lifecycle behavior covers lock ownership, crash recovery, duplicate prevention/idempotency, and partial checkpoint/flush handling.
- AC-6: Queue depth, queue latency, backlog age, summarizer capacity decisions, and failure/backpressure paths are observable in runtime metrics/logs.
- AC-7: The architecture and docs clearly describe the queue-first write path, single-writer ownership, and migration implications from the prior Python queue model.
- AC-8: Verification demonstrates no direct write path bypasses the queue boundary for supported runtime operations.

## Execution Mode
standard
Rationale: shared schema, routing, and writer-lifecycle contracts make the work tightly coupled; several tasks need the same files/contracts, so serializing the plan reduces merge risk and keeps the architecture decisions consistent.

## Workstreams
- Conceptual only; execution is standard and tasks are intended to run in order.
- WS-A: global store, migration, and logical partitioning
- WS-B: queue-first single-writer runtime boundary and writer lifecycle
- WS-C: observability, summarizer capacity policy, and docs/migration notes

## Phases & Tasks
### Phase 0 — Shared Contracts, Tests, and Architecture Guardrails
- [x] **0.1** Draft and review an architecture-decision artifact that fixes partition keys, writer ownership, and migration semantics before code changes
  - Role: planner
  - Deliverable: short ADR/decision note covering canonical project identity, partition key rules, writer ownership, shadow migration, and rollback gates
  - Depends on: none
  - Verify: ADR accepted/referenced by follow-on tasks before implementation begins
- [ ] **0.2** Add/extend failing tests that define the global-store + partitioning contract in the relevant store/runtime test suite
  - Role: test-engineer
  - Deliverable: failing tests covering one physical store, project/user partition separation, and no direct-write bypass
  - Depends on: 0.1
  - Verify: `vitest run ts/packages/runtime/tests/store.test.ts ts/packages/runtime/tests/adapter.test.ts ts/packages/runtime/tests/parity.test.ts` fails before implementation and encodes the expected boundary behavior
- [x] **0.3** Add/extend failing tests for canonical project identity derivation, normalization, collision handling, and routing in the project-routing test suite
  - Role: test-engineer
  - Deliverable: failing tests covering identity derivation, normalization stability, collision behavior, and correct routing/lookup
  - Depends on: 0.1
  - Verify: `vitest run ts/packages/runtime/tests/identity.test.ts ts/packages/runtime/tests/identity-fixtures.test.ts ts/packages/runtime/tests/adapter.test.ts` fails before implementation
- [ ] **0.4** Add/extend failing tests for queue-first write routing, single-writer ownership, and lifecycle failure handling in the queue/runtime test suite
  - Role: test-engineer
  - Deliverable: failing tests covering queue as the only write ingress, lock/ownership, crash recovery, duplicate prevention/idempotency, and partial checkpoint/flush handling
  - Depends on: 0.1
  - Verify: `vitest run ts/packages/runtime/tests/queue-runtime.test.ts ts/packages/runtime/tests/runtime-mode.test.ts ts/packages/runtime/tests/sqlite-sidecar.test.ts` fails before implementation and captures the ownership invariant
- [ ] **0.5** Add/extend failing tests for observability signals, including failure and backpressure paths, in the metrics/telemetry test suite
  - Role: test-engineer
  - Deliverable: failing tests for queue depth, latency, backlog age, capacity-decision emission, retries/errors, and backpressure visibility
  - Depends on: 0.1
  - Verify: `vitest run ts/packages/runtime/tests/shadow-harness.test.ts ts/packages/runtime/tests/shadow-diff.test.ts ts/packages/runtime/tests/queue-runtime.test.ts` fails before implementation and asserts the required signal names or emitted fields
- [ ] **0.6** Add/extend failing tests for schema/data migration, shadow verification, and rollback behavior in the migration test suite
  - Role: test-engineer
  - Deliverable: failing tests covering migration apply, shadow-read/write parity, and rollback to the prior schema/path
  - Depends on: 0.1
  - Verify: `vitest run ts/packages/runtime/tests/shadow-harness.test.ts ts/packages/runtime/tests/adapter-shadow.test.ts ts/packages/runtime/tests/shadow-diff.test.ts` fails before implementation

### Phase 1 — Core Architecture Implementation
- [x] **1.1** Implement global physical store routing with logical project/user partitioning in the store layer
  - Role: backend-coder
  - Deliverable: store changes that persist all memory in one SQLite-backed physical store while tagging/routing by partition
  - Depends on: 0.2, 0.3
  - Verify: `vitest run ts/packages/runtime/tests/store.test.ts ts/packages/runtime/tests/adapter.test.ts ts/packages/runtime/tests/parity.test.ts` passes and confirms partition-aware reads/writes against one database
- [x] **1.2** Implement canonical project identity derivation, normalization, collision handling, and routing in the project-routing layer
  - Role: backend-coder
  - Deliverable: deterministic identity/routing logic with explicit collision strategy and lookup normalization
  - Depends on: 0.3
  - Verify: `vitest run ts/packages/runtime/tests/identity.test.ts ts/packages/runtime/tests/identity-fixtures.test.ts ts/packages/runtime/tests/adapter.test.ts` passes
- [x] **1.3** Implement queue-only write ingress and single-writer SQLite ownership in the runtime/queue layer
  - Role: backend-coder
  - Deliverable: queue consumer/writer path that accepts all writes, serializes them, and is the only SQLite owner
  - Depends on: 0.4, 1.1, 1.2
  - Verify: `vitest run ts/packages/runtime/tests/queue-runtime.test.ts ts/packages/runtime/tests/runtime-mode.test.ts ts/packages/runtime/tests/sqlite-sidecar.test.ts` passes and direct-write bypass tests remain green
- [ ] **1.4** Implement writer lifecycle handling for lock ownership, crash recovery, duplicate prevention/idempotency, and partial checkpoint/flush cases
  - Role: backend-coder
  - Deliverable: resilient writer state handling and recovery logic around queue drains and SQLite checkpoints
  - Depends on: 0.4, 1.3
  - Verify: writer lifecycle tests pass, including crash/restart and duplicate-event scenarios
- [ ] **1.5** Encode summarizer capacity decision logic at the queue boundary so backpressure and throughput decisions are explicit
  - Role: backend-coder
  - Deliverable: capacity-policy code that records or emits decisions tied to queue state and summarizer availability
  - Depends on: 0.5, 1.3
  - Verify: policy tests pass and decision outputs are visible in logs/metrics

### Phase 2 — Integration, Migration, and Compatibility
- [x] **2.1** Inventory and retire all direct write entrypoints before cutover, including `write-path.ts`, `store-actions.ts`, `session-capture.ts`, `queue-runtime.ts`, `adapter.ts`, and `pi-extension.ts`
  - Role: backend-coder
  - Deliverable: explicit removal or redirection of every direct write path into the queue-first writer boundary
  - Depends on: 1.3, 1.4
  - Verify: repo search and targeted runtime tests confirm no supported direct-write entrypoint remains
- [x] **2.2** Wire the runtime entrypoints to the queue-first writer path and remove any direct store-write paths from supported flows
  - Role: builder
  - Deliverable: integrated runtime path with no supported direct SQLite writes outside the writer process
  - Depends on: 2.1
  - Verify: `vitest run ts/packages/runtime/tests/adapter.test.ts ts/packages/runtime/tests/session-capture.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts` confirms supported operations always enqueue writes
- [ ] **2.3** Implement schema/data migration with shadow verification and rollback-safe cutover guards
  - Role: backend-coder
  - Deliverable: migration code plus shadow-read/write parity checks and rollback path to the prior schema/path
  - Depends on: 1.1, 1.2, 1.3
  - Verify: `vitest run ts/packages/runtime/tests/shadow-harness.test.ts ts/packages/runtime/tests/adapter-shadow.test.ts ts/packages/runtime/tests/shadow-diff.test.ts` pass, including rollback assertions
- [x] **2.4** Add migration notes and architecture docs describing the new global store, logical partitioning, and old Python queue lessons
  - Role: documenter
  - Deliverable: updated docs page or sprint notes covering architecture, behavior changes, and migration cautions
  - Depends on: 2.3
  - Verify: documentation review confirms the queue-first and single-writer model is clearly described
- [x] **2.5** Add compatibility checks or guards that fail fast if a code path attempts multi-writer SQLite access or direct store bypass
  - Role: backend-coder
  - Deliverable: defensive assertions or tests that protect the architecture boundary
  - Depends on: 1.4, 2.3
  - Verify: guard tests pass and any prohibited access is blocked deterministically

### Phase 3 — Hardening and Observability
- [ ] **3.1** Surface queue depth, queue latency, backlog age, writer/summarizer capacity metrics, and failure/backpressure signals in the runtime observability layer
  - Role: backend-coder
  - Deliverable: emitted telemetry fields or metrics counters/gauges for queue health, error/backpressure paths, and capacity
  - Depends on: 1.3, 1.5, 2.4
  - Verify: observability tests or smoke checks confirm metric emission under load and during injected failures/backpressure
- [ ] **3.2** Validate backlog, retry, and failure-path behavior with representative load or simulation and document operational thresholds
  - Role: test-engineer
  - Deliverable: load/behavior verification notes showing backlog, retries, and latency signals under pressure and failure
  - Depends on: 3.1
  - Verify: simulation or integration tests show queue metrics moving as expected and document thresholds
- [ ] **3.3** Perform code review cleanup for any shared boundaries that still imply per-project physical stores or direct-write semantics
  - Role: code-reviewer
  - Deliverable: review notes and any final cleanup requests
  - Depends on: 2.1, 3.1
  - Verify: review sign-off confirms the architecture matches the sprint objective

## Verification
- Run `vitest run ts/packages/runtime/tests/store.test.ts ts/packages/runtime/tests/parity.test.ts ts/packages/runtime/tests/adapter.test.ts` for partitioning and write-boundary behavior
- Run `vitest run ts/packages/runtime/tests/identity.test.ts ts/packages/runtime/tests/identity-fixtures.test.ts ts/packages/runtime/tests/adapter.test.ts` for canonical identity and routing behavior
- Run `vitest run ts/packages/runtime/tests/queue-runtime.test.ts ts/packages/runtime/tests/runtime-mode.test.ts ts/packages/runtime/tests/sqlite-sidecar.test.ts` for single-writer ownership, lifecycle, and serialized writes
- Run `vitest run ts/packages/runtime/tests/shadow-harness.test.ts ts/packages/runtime/tests/adapter-shadow.test.ts ts/packages/runtime/tests/shadow-diff.test.ts` for schema/data migration, shadow verification, and rollback behavior
- Run telemetry/metrics tests covering queue depth, latency, backlog age, capacity decisions, and failure/backpressure signals
- Run integration or end-to-end tests that exercise supported write flows through the queue
- Confirm documentation and migration notes reflect the finalized architecture

## Risks & Mitigations
- Risk: existing code may assume direct SQLite access or per-project databases
  - Mitigation: add failing tests first, then compatibility guards and integration checks before removing old paths
- Risk: queue bottlenecks could increase latency under load
  - Mitigation: expose queue depth/latency/backlog metrics early and define operational thresholds for summarizer capacity decisions
- Risk: partition metadata could become ambiguous if project and user scopes are not consistently tagged
  - Mitigation: centralize partition labeling in the store boundary and test both read and write paths
- Risk: lessons from the old Python queue architecture may be lost during translation to TypeScript
  - Mitigation: document the specific behavior differences and preserve the beneficial queue discipline while rejecting multi-writer patterns

## Migration Notes
- The new design keeps one physical SQLite store and replaces any assumption of per-project physical storage with logical partitioning.
- Writes must be treated as asynchronous queue work; callers should not expect immediate direct persistence through a local store API.
- Any legacy queue semantics from the Python architecture should be reviewed for relevance, especially around durability, retry, and backlog handling.
- Rollout should favor compatibility checks, shadow verification, and rollback readiness before disabling old direct-write paths.
- Partition keys, writer ownership, and schema migration semantics must be fixed by the Phase 0 architecture-decision artifact before coding begins.

## Observability Requirements
- Emit queue depth as a continuously visible metric or log field.
- Emit queue latency, including enqueue-to-write or enqueue-to-drain timing.
- Emit backlog age so stale work can be detected operationally.
- Emit summarizer capacity decisions so throttling or admission choices are explainable.
- Emit failure and backpressure signals for lock contention, retry, crash recovery, and partial flush/checkpoint handling.
- Keep observability tied to the queue boundary and single-writer process, not to callers.

## Definition of Done
- [x] AC-1, AC-2, AC-3, AC-7, and AC-8 are validated in the implemented runtime/package slice
- [x] Tests pass for store, queue, package-surface, and integration layers in the changed runtime area
- [x] Review sign-off is satisfied for the queue-first single-writer/public-surface boundary implemented in this sprint
- [x] Docs and migration notes are updated for the finalized runtime shape
- [x] No known direct-write bypass remains in supported flows or the public runtime package surface
- [x] Sprint 24 closeout is complete for the implemented scope; deferred follow-on work is recorded separately
- Status: complete for the implemented queue-first single-writer/public-surface scope; deeper observability, migration/rollback automation, and broader guarded replace/prune follow-on work are no longer Sprint 24 blockers

## Current Status
- [x] Sprint doc exists and is finalized
- [x] Identity/project routing slice is complete and verified
- [x] Queue persistence/lifecycle scaffolding exists and related runtime tests are green
- [x] Queue-backed adapter write slice and entrypoint migration work have landed in the tested runtime area
- [x] Shadow/native result-shape alignment and related tests are green in the current runtime slice
- [x] **1.3 / AC-1 are complete** for the supported runtime and public package surface: supported writes stay queue-backed, the public `sqlite-sidecar` module is reader-only, the mutator path lives in `sqlite-sidecar-internal.ts`, and the root runtime barrel no longer exposes direct store/sidecar bypass APIs
- [x] **2.5 is complete**: package-surface compatibility guards now come from root-barrel narrowing plus runtime/package-surface tests that assert direct store/sidecar/write-path helpers are absent from the public runtime export surface
- [x] AC-8 is complete: verification demonstrates no direct write path bypasses the queue boundary for supported runtime operations
- [x] Sprint 24 is closed on the implemented scope
- [ ] Deferred follow-on backlog: deeper observability, fuller migration/rollback automation, and broader replace/prune queue semantics

## Notes
- The original Sprint 24 plan was broader than the final implemented closeout scope.
- Sprint 24 closes on the verified queue-first single-writer, global-store partitioning, and public package-surface hardening slices implemented in the TypeScript runtime.
- Follow-on observability, migration/rollback automation, and broader guarded replace/prune work remain worthwhile, but they are no longer treated as Sprint 24 blockers.
- Verification for closeout included the focused sidecar/store/queue/runtime suites plus the broader changed-area runtime suite, including public-barrel coverage.
