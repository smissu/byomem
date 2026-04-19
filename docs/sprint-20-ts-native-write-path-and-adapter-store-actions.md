# Sprint 20: TS Native Write Path and Adapter Store Actions

## Objective
Implement the TS-native write path and adapter-facing store actions so records can be created, updated, and projected through the native runtime without relying on the old Python-first write behavior.

## Scope
- Implement native write APIs and mutation handling.
- Add adapter-friendly store actions for create/update/upsert semantics as required by the current BYOMem flow.
- Ensure writes update the durable store, identity, and retrieval views consistently.
- Add tests for write correctness and state transitions.

## Non-goals
- Session capture queue migration.
- Adapter shadow mode or cutover.
- Legacy retirement.
- Major ranking redesign.

## Dependencies
- Sprint 17 store and identity.
- Sprint 18 read path.
- Sprint 19 search/ranking parity.

## Investigation Summary
Current repo planning docs position Sprint 18 as the read-path baseline and Sprint 19 as the retrieval parity gate. This sprint stays narrowly focused on TS-native write semantics and adapter store actions so that the TS runtime becomes the active write path before later queue and cutover work, without expanding into session-capture migration here.

## Acceptance Criteria
- AC-1: The native write path can create and update records in the durable store.
- AC-2: Adapter-facing store actions correctly map to the native write semantics.
- AC-3: Read/search views reflect written data immediately and after reload.
- AC-4: Tests cover write success, idempotency, and invalid mutation handling.
- AC-5: The TS write path is the active path for covered mutations, and Python is no longer required in steady state once this cutover completes.

## Execution Mode
Standard.
Rationale: write-path behavior and adapter store actions are tightly coupled through mutation semantics and should be implemented as one coherent change set.

## Phases & Tasks
### Phase 0 — Failing mutation tests
- [ ] **0.1** Add tests for create/update/upsert and invalid write cases in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED write-path tests.
  - Verify: targeted write-path pytest command.

- [ ] **0.2** Add fixture cases for adapter-facing write actions in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: mutation fixture set.
  - Verify: fixtures are consumed by the new tests.

### Phase 1 — Native write implementation
- [ ] **1.1** Implement the native write API in `src/` or the runtime package
  - Role: typescript-coder
  - Deliverable: write handler that persists canonical records.
  - Verify: write tests pass.

- [ ] **1.2** Implement adapter store action mapping for write/create/update/upsert semantics
  - Role: typescript-coder
  - Deliverable: adapter action layer calling the native write API.
  - Verify: adapter-focused write tests pass.

### Phase 2 — Integration verification and docs
- [ ] **2.1** Add end-to-end tests for write -> read -> search consistency
  - Role: test-engineer
  - Deliverable: integrated mutation/read coverage.
  - Verify: E2E unit/integration command passes.

- [ ] **2.2** Update write-path notes in `docs/session-memory-native-architecture.md` and migration docs
  - Role: documenter
  - Deliverable: write-path documentation update.
  - Verify: docs describe native mutation semantics clearly.

## TDD / Verification Strategy
- RED: start with failing mutation tests and invalid-input cases.
- GREEN: implement the native write API, then adapter actions.
- REFACTOR: ensure read/search views stay consistent after write.
- Recommended checks: targeted write tests, adapter-action tests, and a read-after-write smoke test.

## Pseudocode / Design Sketch
```text
write(intent):
  validate intent
  resolve stable identity
  persist canonical record
  invalidate/update retrieval indexes
  return write result with stable id

adapterAction(payload) -> normalize -> write(intent)
```

## Risks & Mitigations
- Risk: write semantics diverge from existing caller expectations.
  - Mitigation: keep adapter mapping explicit and test current payload variants.
- Risk: writes update store but not derived views.
  - Mitigation: add integrated read/search assertions after every mutation path.

## Rollback
- Revert mutation logic if write consistency or identity stability regresses.

## Verification Commands
- `pytest tests/unit/ -k write`
- `pytest tests/unit/ -k adapter and write`
- `pytest tests/integration/ -k write`
- `npm test -- --runInBand` or the repo-specific TS test command covering `src/` write and adapter action behavior

## See Also
- `docs/sprint-17-ts-native-store-and-stable-identity.md`
- `docs/sprint-18-ts-native-read-path-and-retrieval-baseline.md`
- `docs/sprint-19-ts-search-and-ranking-parity.md`
- `docs/session-memory-native-architecture.md`

## Definition of Done
- [ ] Native write path exists.
- [ ] Adapter store actions map cleanly to native writes.
- [ ] Read/search consistency is proven.
- [ ] Docs are updated for mutation semantics.
- [ ] Ready for Sprint 21 session capture and queue migration.
