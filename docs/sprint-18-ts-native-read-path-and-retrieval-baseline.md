# Sprint 18: TS Native Read Path and Retrieval Baseline

## Objective
Build the TS-native read path and establish the baseline retrieval behavior on top of the durable store introduced in Sprint 17. This sprint makes native reads the primary way to inspect BYOMem records, while keeping search/ranking refinements for later sprints.

## Scope
### In scope
- Implement native read APIs over the durable store.
- Return canonical record shapes with identity, provenance, and scope intact.
- Establish baseline retrieval semantics for exact/identity-oriented reads and simple contextual retrieval.
- Add tests that prove read-path correctness independent of markdown-backed behavior.

## Non-goals
- Advanced search ranking and hybrid relevance tuning.
- Write-path adapter actions.
- Session capture queue migration.
- Shadow validation or cutover.

## Dependencies
- Sprint 17 durable store and stable identity.
- Sprint 16 contracts and fixtures.
- This sprint should make TypeScript the primary read/runtime path while treating Python-backed behavior as transitional only.

## Investigation Summary
- The sprint sits on top of the stable store/identity contract from Sprint 17 and should not rework persistence semantics.
- Current docs frame retrieval as the next step after native storage; this sprint should make that sequencing explicit and keep markdown out of the correctness path.
- The intended end state is a TS-native read path that serves as the authoritative runtime behavior, with Python remaining only as a transitional fallback during migration.

## Acceptance Criteria
- AC-1: Native read APIs can retrieve a record by stable identity and return the canonical native shape.
- AC-2: Simple baseline retrieval works against the native store without consulting markdown as the source of truth.
- AC-3: Returned records preserve identity, provenance, scope, and content fields.
- AC-4: Tests show the read path remains correct after reload.
- AC-5: Retrieval behavior is documented and verified as part of the TS-authoritative runtime path, not as a Python-dependent fallback.

## Phases & Tasks
### Phase 0 — Failing tests for read-path behavior
- [ ] **0.1** Add unit tests for identity lookup, canonical record shape, and post-reload retrieval in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED tests that define baseline native read behavior.
  - Verify: targeted pytest command for read-path tests.

### Phase 1 — Native read implementation
- [ ] **1.1** Implement the read API in the runtime/store layer under `src/` or the repo’s runtime package
  - Role: typescript-coder
  - Deliverable: native read path returning canonical records.
  - Verify: read-path tests pass.

- [ ] **1.2** Wire retrieval helpers so identity and simple contextual reads use the native store as the source of truth
  - Role: typescript-coder
  - Deliverable: retrieval baseline helpers and lookup logic.
  - Verify: tests confirm markdown is no longer required for correctness.

### Phase 2 — Verification and documentation
- [ ] **2.1** Add a retrieval smoke test that exercises read-after-write and read-after-reload flows
  - Role: test-engineer
  - Deliverable: end-to-end baseline read coverage.
  - Verify: smoke test passes in the normal unit test command set.

- [ ] **2.2** Update read-path notes in `docs/session-memory-native-architecture.md` to describe the baseline retrieval contract
  - Role: documenter
  - Deliverable: read-path documentation update.
  - Verify: docs match the canonical shape and source-of-truth rules.

## Execution Mode
Standard.
Rationale: the read path and baseline retrieval semantics share the same store boundary and should be implemented and verified together.

## Verification Commands
- `pytest -q tests/unit/test_read_path*.py`
- `pytest -q tests/integration/test_read_reload*.py`
- `pytest -q tests/unit/test_retrieval_baseline*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript read-path/retrieval test command

## TDD / Verification Strategy
- RED: add read-path tests before implementing the APIs.
- GREEN: expose the minimal native read helpers and retrieval baseline.
- REFACTOR: keep read helpers thin and reusable for search/ranking in Sprint 19.
- Recommended checks: targeted read-path tests and a reload smoke test.

## Pseudocode / Design Sketch
```text
readById(id):
  record = store.get(id)
  if record missing -> return not found
  else return canonical native record

retrieve(query):
  if query is identity-like -> direct lookup
  else use minimal native filter over store records
```

## Risks and Rollback
- Risk: read path accidentally reintroduces markdown dependency.
  - Mitigation: add tests that fail if markdown is needed for core reads.
- Risk: baseline retrieval semantics are too broad and conflict with search ranking later.
  - Mitigation: keep this sprint minimal and identity-first.
- Rollback: revert read-path helpers if they destabilize stable identity or reload behavior.

## Definition of Done
- [ ] Native read path is implemented.
- [ ] Baseline retrieval is stable and tested.
- [ ] Canonical record shape is preserved.
- [ ] Docs reflect the native source of truth.
- [ ] Ready for Sprint 19 search/ranking parity.
