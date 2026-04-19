# Sprint 16: TS Runtime Foundation and Core Contracts

## Objective
Establish the TypeScript-native runtime foundation for BYOMem by defining the core domain contracts, runtime boundaries, and test harnesses that later sprints will build on. This sprint does not move behavior yet; it makes the native path explicit, typed, and verifiable against the current Python-first state.

Program-level statement: Python is transitional only in this migration and must be absent from the steady-state active runtime path by the end of Sprint 23.

## Scope
### In scope
- Define canonical TS contracts for memory records, provenance, scope, identity, retrieval results, write intents, and queue/session events.
- Establish package/module boundaries for runtime, store, search, adapter, and session capture layers.
- Add baseline fixtures and contract tests that describe the native-first shape without requiring full native behavior.
- Document the migration sequence and file ownership for the TS-native completion plan.

## Non-goals
- Implementing the durable native store.
- Changing read-path semantics or ranking behavior.
- Replacing Python-backed write or capture flows.
- Adapter cutover, shadow validation, or legacy retirement.

## Dependencies
- Current repo state and existing Python-backed BYOMem behavior.
- Existing docs: `docs/sprint-11-ts-byomem-contracts-and-parity.md`, `docs/sprint-14-ts-native-retrieval-and-ranking.md`, `docs/sprint-15-ts-doc-cleanup-and-legacy-retirement.md`.
- Existing verification fixtures and any TS/Python contract tests already present in the repo.
- Follow-on delivery path: sprints 17-23 should consume these contracts so TypeScript becomes the authoritative runtime path and Python remains transitional only.

## Investigation Summary
- The current repo still centers Python-backed behavior, so this sprint should only codify the TS-native contract surface and avoid behavior changes.
- Existing sprint docs already establish the 11/14/15 migration context; this sprint should narrow that into explicit runtime boundaries and stable record shapes.
- Contract-first work here is the foundation for later store/read cutover, with Python retained only as a transitional compatibility layer.

## Acceptance Criteria
- AC-1: The native BYOMem core data model is documented in TS-friendly terms with stable identifiers and explicit provenance/scope fields.
- AC-2: The runtime boundary between store, search, write, session capture, and adapter layers is clear in docs and aligned with the contract artifacts.
- AC-3: Contract tests or fixtures exist that pin the expected native shapes and prevent accidental drift.
- AC-4: The sprint sequence and dependency chain for sprints 16-23 are documented in the repo.
- AC-5: The documented contract path clearly positions TypeScript as the future authoritative runtime, with Python described only as a temporary transition path.

## Phases & Tasks
### Phase 0 — Contract discovery and baseline shape
- [ ] **0.1** Inventory current Python-first and TS-adjacent BYOMem entry points in `docs/`, `src/`, and `tests/`
  - Role: codebase-investigator
  - Deliverable: short source map identifying current runtime seams and the files that must stay stable during the migration.
  - Verify: documented evidence of contract surfaces and existing test coverage.

- [ ] **0.2** Draft the canonical TS-native contract sketch for records, provenance, scope, identity, and queued events in `docs/sprint-16-ts-runtime-foundation-and-core-contracts.md`
  - Role: planner
  - Deliverable: updated sprint plan plus a concise design sketch that later implementation sprints can follow.
  - Verify: explicit field list and boundary notes are present.

### Phase 1 — Shared contract artifacts
- [ ] **1.1** Add or update contract fixture files for native memory records and retrieval/write intent shapes in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: stable fixtures that encode the intended TS-native shapes.
  - Verify: fixture-driven tests fail before implementation and pass once contracts are wired.

- [ ] **1.2** Add contract tests that validate record identity, provenance, scope, and queue-event envelopes in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED tests for the native contract boundary.
  - Verify: targeted test command for the new contract suite.

### Phase 2 — Runtime boundary documentation
- [ ] **2.1** Document module responsibilities and dependency directions for runtime, store, search, write, session capture, and adapter layers in `docs/session-memory-native-architecture.md`
  - Role: documenter
  - Deliverable: updated architecture notes and a clear ownership map.
  - Verify: docs reflect the intended migration order and avoid ambiguous shared ownership.

- [ ] **2.2** Update `docs/pi-memory-roadmap.md` and this sprint sequence index to point to sprints 16-23 as the TS-native completion path
  - Role: documenter
  - Deliverable: aligned roadmap references.
  - Verify: no stale sequence references remain in the primary docs.

## Execution Mode
Standard.
Rationale: this sprint is contract-first and doc-first groundwork; it should remain narrow and avoid behavior changes.

## Verification Commands
- `pytest -q tests/unit/test_contract*.py`
- `pytest -q tests/unit/test_memory_contract*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript contract/test command
- `grep -R "stable id\|provenance\|queue-event" docs/ tests/ src/

## TDD / Verification Strategy
- Start with contract tests that describe the intended shape and fail against the current state.
- Use fixture-driven validation for record identity and envelope stability.
- Keep implementation changes out of this sprint unless they are required to unblock the contract tests.
- Recommended checks: targeted unit tests for the new contract suite and a doc link review.

## Pseudocode / Design Sketch
```text
NativeMemoryRecord {
  id: stable canonical id
  scope: project | user | session | team
  provenance: source, timestamp, adapter metadata
  content: text + structured payload
  identity: leaf name + parent context + stable namespace
}

QueueEvent {
  eventId
  sessionId
  recordId
  kind: capture | flush | write | replay
  createdAt
  payload
}
```

## Risks and Rollback
- Risk: over-specifying the contract before implementation details are known.
  - Mitigation: keep the contract minimal and focused on fields already required by later sprints.
- Risk: contract fixtures drift from the Python baseline.
  - Mitigation: anchor fixtures to current observed behavior and mark any intentional divergence.
- Rollback: revert doc/fixture additions if they over-constrain later implementation or conflict with established baseline tests.

## Definition of Done
- [ ] Core TS-native contract shapes are documented.
- [ ] Contract tests/fixtures exist for stable identities and envelopes.
- [ ] Runtime boundaries are clear and sequenced.
- [ ] Sprint sequence docs point to the new TS-native path.
- [ ] Ready for Sprint 17 implementation work.
