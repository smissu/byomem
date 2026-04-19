# Sprint 22: TS Adapter Integration and Shadow Validation

## Objective
Integrate the TS-native runtime with the adapter surface and run shadow validation against the legacy path so the native implementation can be compared safely before cutover.

## Scope
### In scope
- Connect adapter entry points to the TS-native runtime.
- Run shadow validation between native and legacy flows.
- Capture diffs for store, read, search, write, session-capture, and queue behaviors.
- Add tests or tooling to compare expected outputs without switching production traffic.
- Tighten the cutover gate so native and legacy outputs are comparable on concrete, testable fixtures.

## Non-goals
- Full cutover and legacy retirement.
- New functional behavior beyond parity fixes discovered in shadow mode.
- Major contract redesign.
- Making the TS-native runtime authoritative in production during this sprint.

## Dependencies
- Sprints 17 through 21 completed or sufficiently stable for validation.
- Existing adapter surface in the repo.
- Known baseline outputs from the Python-first path.
- Native store, read, write, and session-capture runtime behavior available for comparison.

## Investigation Summary
- The repo already has native store/read/write and session-capture work staged in Sprints 17-21, plus a native session-memory architecture note that treats the TS path as the desired end state.
- Sprint 22 is the comparison gate: adapter entry points should be able to call the TS runtime in shadow mode while the legacy path remains the production authority.
- Validation must cover store, read, search, write, session-capture, and queue surfaces with deterministic fixtures so Sprint 23 can make a clear cutover decision.

## Execution Mode
Standard.
Rationale: integration and shadow validation are coupled through the adapter boundary and should be executed as one controlled comparison phase.

## Acceptance Criteria
- AC-1: Adapter entry points can invoke the TS-native runtime in shadow mode.
- AC-2: Shadow comparisons produce actionable diffs for key flows without affecting primary behavior.
- AC-3: Identified parity gaps are either fixed or explicitly documented as accepted deviations.
- AC-4: The native runtime is proven ready for cutover execution.
- AC-5: Shadow mode remains non-authoritative; production traffic still returns the legacy result during this sprint.
- AC-6: The cutover gate is based on concrete, repeatable tests for store/read/search/write/session-capture/queue parity.

## Phases & Tasks
### Phase 0 — Shadow test scaffolding
- [ ] **0.1** Add shadow comparison tests or harnesses for adapter-backed flows in `tests/unit/` or `tests/integration/`
  - Role: test-engineer
  - Deliverable: RED shadow validation scaffolding.
  - Verify: comparison harness command or targeted tests.

- [ ] **0.2** Define baseline diff fixtures for store/read/search/write/session/queue paths in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: comparison fixture set.
  - Verify: fixtures are referenced by the harness.

### Phase 1 — Adapter integration
- [ ] **1.1** Route adapter entry points through the TS-native runtime in shadow mode
  - Role: typescript-coder
  - Deliverable: adapter-to-native integration path.
  - Verify: adapter flows exercise native code while preserving the existing output path.

- [ ] **1.2** Implement diff capture for native vs legacy outputs across the target flows
  - Role: typescript-coder
  - Deliverable: structured shadow diff reporting.
  - Verify: comparisons generate stable, reviewable diffs.

### Phase 2 — Validation and documentation
- [ ] **2.1** Review and resolve parity gaps uncovered by shadow validation
  - Role: builder
  - Deliverable: parity fix list or approved deviations.
  - Verify: rerun comparison suite with reduced diff surface.

- [ ] **2.2** Update adapter and migration docs in `docs/` to reflect shadow mode results and cutover readiness
  - Role: documenter
  - Deliverable: validation summary in docs.
  - Verify: docs clearly distinguish shadow-mode validation from production cutover.

## TDD / Verification Strategy
- RED: create shadow harnesses and diff assertions before routing traffic.
- GREEN: connect adapter entry points to the native runtime in a non-breaking shadow path.
- REFACTOR: keep diff reporting isolated from production code paths.
- Recommended checks: adapter shadow tests and diff review runs.

## Pseudocode / Design Sketch
```text
adapterCall(input):
  legacyOutput = currentPath(input)
  nativeOutput = shadowNativePath(input)
  diff = compare(legacyOutput, nativeOutput)
  record diff
  return legacyOutput
```

## Risks & Mitigations
- Risk: shadow wiring introduces latency or side effects.
  - Mitigation: keep native calls non-authoritative and side-effect isolated in shadow mode.
- Risk: diffs are noisy and obscure real parity gaps.
  - Mitigation: normalize outputs before comparison and keep fixtures representative.
- Risk: the shadow path accidentally becomes authoritative.
  - Mitigation: add tests that assert legacy remains the returned result until Sprint 23 cutover.

## Rollback
- Disable shadow routing and retain legacy adapter behavior if validation causes instability.
- Remove any adapter integration changes that cause the comparison harness to mutate production state.

## Verification Commands
- `pytest -q tests/unit/test_adapter_shadow*.py`
- `pytest -q tests/integration/test_adapter_shadow*.py`
- `pytest -q tests/unit/test_shadow_diff*.py`
- `pytest -q tests/integration/test_store_read_search_write_session_queue_parity*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript test command for adapter/runtime coverage

## See Also
- `docs/session-memory-native-architecture.md`
- `docs/sprint-20-ts-native-write-path-and-adapter-store-actions.md`
- `docs/sprint-21-ts-session-capture-and-queue-runtime-migration.md`
- `docs/sprint-18-ts-native-read-path-and-retrieval-baseline.md`
- `docs/verification/README.md`

## Definition of Done
- [ ] Adapter shadow validation is wired.
- [ ] Diff outputs are stable and reviewable.
- [ ] Parity gaps are understood and bounded.
- [ ] Docs reflect cutover readiness.
- [ ] The shadow gate proves the native runtime matches legacy behavior on the required flows.
- [ ] Ready for Sprint 23 runtime cutover and retirement.
