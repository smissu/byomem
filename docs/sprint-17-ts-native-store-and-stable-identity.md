# Sprint 17: TS Native Store and Stable Identity

## Objective
Implement the durable TypeScript-native store and stable identity mechanics so BYOMem records can be persisted and addressed without relying on Python-backed storage behavior. This sprint is the first behavior-changing implementation step after the contract foundation.

## Scope
### In scope
- Implement the native store persistence layer.
- Establish stable identity generation and collision rules.
- Add store-level read/write primitives needed by later retrieval and adapter sprints.
- Lock identity semantics with tests and fixtures.

## Non-goals
- Search/ranking tuning.
- Adapter shadow mode or cutover.
- Session capture queue migration.
- Legacy retirement or documentation closure beyond store-specific notes.

## Dependencies
- Sprint 16 contract artifacts and runtime boundaries.
- Current repo state for existing Python-backed and transitional identity behavior.
- This sprint should preserve the path toward TS as the authoritative runtime while keeping Python-backed flows transitional only.

## Investigation Summary
- The repo’s current behavior still depends on Python-era identity expectations, so this sprint should introduce durable TS identity without widening scope into retrieval or adapter cutover.
- Sprint 16 contract work defines the target shapes; this sprint operationalizes those shapes in persistence and identity logic.
- Stable identity must be implemented in a way that downstream read-path work can treat TypeScript storage as the source of truth.

## Acceptance Criteria
- AC-1: Native records can be written to and read from the TS-native store with stable IDs preserved across reloads.
- AC-2: Identity collisions are resolved deterministically according to documented rules.
- AC-3: The store exposes minimal primitives required by later read, search, and write sprints.
- AC-4: Tests prove that identity remains stable for the same logical memory across process restarts.
- AC-5: Store semantics are strong enough that later sprints can move reads and retrieval to TypeScript as the authoritative runtime path, leaving Python only transitional.

## Phases & Tasks
### Phase 0 — Failing tests and identity fixtures
- [ ] **0.1** Add failing tests for stable identity generation and collision handling in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED tests that encode the identity contract.
  - Verify: targeted pytest command for the new identity suite.

- [ ] **0.2** Add fixture examples for same-leaf-name, different-scope, and same-scope collision cases in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: canonical collision fixtures.
  - Verify: fixtures are referenced by the new tests.

### Phase 1 — Store implementation
- [ ] **1.1** Implement the TS-native store persistence module in `src/` or the repo’s equivalent runtime package
  - Role: typescript-coder
  - Deliverable: durable store implementation with read/write primitives.
  - Verify: store-specific unit tests pass.

- [ ] **1.2** Implement stable identity derivation and namespace handling for native records
  - Role: typescript-coder
  - Deliverable: identity helper(s) used by the store and future adapters.
  - Verify: repeated writes of the same logical record resolve to the same stable ID.

### Phase 2 — Store verification and docs
- [ ] **2.1** Add reload/reopen tests proving persistence and identity stability across process boundaries
  - Role: test-engineer
  - Deliverable: persistence regression coverage.
  - Verify: reload-oriented pytest command or equivalent.

- [ ] **2.2** Update store notes in `docs/session-memory-native-architecture.md` and related docs to reflect the native store as the source of truth
  - Role: documenter
  - Deliverable: concise store documentation update.
  - Verify: documentation matches the implemented primitive set.

## Execution Mode
Standard.
Rationale: the store and identity work is tightly coupled and should be kept in one implementation track with shared tests and shared persistence paths.

## Verification Commands
- `pytest -q tests/unit/test_identity*.py`
- `pytest -q tests/unit/test_store*.py`
- `pytest -q tests/integration/test_store_reload*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript store/identity test command

## TDD / Verification Strategy
- RED: write tests for stable ID generation, collision handling, and persistence reload behavior first.
- GREEN: implement the minimal store and identity logic required by those tests.
- REFACTOR: ensure the identity helper is reusable by retrieval and adapter layers.
- Recommended checks: targeted unit tests for identity/store, plus a reload or persistence smoke test.

## Pseudocode / Design Sketch
```text
stableId = hash(namespace + scope + parentContext + normalizedLeafName)
store.write(record) -> persist by stableId
store.read(stableId) -> return canonical native record
if collision on same stableId:
  apply documented deterministic merge/replace rule
```

## Risks and Rollback
- Risk: identity rules are too strict and break legitimate distinct records.
  - Mitigation: keep namespace/scope inputs explicit and test real-world collision cases.
- Risk: store implementation leaks Python-era assumptions.
  - Mitigation: keep the store native-first and narrow the compatibility surface.
- Rollback: revert store changes and preserve contract tests if persistence or identity semantics regress.

## Definition of Done
- [ ] Native store persistence exists.
- [ ] Stable identity rules are implemented and tested.
- [ ] Reload behavior is proven.
- [ ] Docs are aligned with native source-of-truth semantics.
- [ ] Ready for Sprint 18 read-path work.
