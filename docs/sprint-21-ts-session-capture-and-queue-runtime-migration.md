# Sprint 21: TS Session Capture and Queue Runtime Migration

## Objective
Migrate session capture and queue runtime behavior to the TypeScript-native path so live transcript/session events are captured, queued, flushed, and replayed without depending on the Python runtime as the active executor.

## Scope
### In scope
- Implement TS-native session capture event ingestion.
- Migrate queue runtime handling for capture/flush/replay events.
- Ensure captured events persist to the native store and remain retrievable.
- Add tests for queue processing, flush behavior, replay safety, and restart resilience.

## Non-goals
- Adapter shadow validation and cutover.
- Legacy retirement.
- Search ranking redesign.
- Major data model changes beyond queue/event needs.
- Any Python runtime behavior change outside the session-capture/queue surface.

## Dependencies
- Sprint 17 store and identity.
- Sprint 18 read path.
- Sprint 20 write path and adapter store actions.
- Existing session-capture behavior in the repo.
- Native store persistence and stable identity primitives already in place.

## Investigation Summary
- The repo already has native store/write/read groundwork in Sprints 17-20 and a dedicated architecture note at `docs/session-memory-native-architecture.md` describing session-derived memory as native records.
- The current sprint sequence assumes session capture is the next runtime gap: events must be ingested, queued, and flushed through the same TS-native store/write path used by earlier sprints.
- This sprint should stay focused on the runtime boundary only; adapter shadowing and cutover are deferred to Sprints 22-23.

## Execution Mode
Standard.
Rationale: capture and queue migration share state, event semantics, and persistence, so they should be implemented in one controlled track.

## Acceptance Criteria
- AC-1: Session capture events can be ingested by the TS-native runtime.
- AC-2: Queue processing can flush and replay events into the native store.
- AC-3: Captured session data remains retrievable after flush/restart.
- AC-4: Tests demonstrate queue migration does not break write/read semantics.
- AC-5: The active session-capture/queue runtime path does not invoke Python.
- AC-6: Any retained Python code for this sprint is offline/dev-only or hidden behind an explicit disabled-by-default compatibility escape hatch.

## Phases & Tasks
### Phase 0 — Failing event-flow tests
- [ ] **0.1** Add tests for capture ingest, queue flush, replay, and restart persistence in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED queue/session tests.
  - Verify: targeted session-capture pytest command.

- [ ] **0.2** Add event-envelope fixtures for capture, flush, replay, and restart in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: canonical queue event examples.
  - Verify: fixtures are consumed by the tests.

### Phase 1 — Runtime migration
- [ ] **1.1** Implement TS-native session capture ingestion and queue orchestration in `src/`
  - Role: typescript-coder
  - Deliverable: event capture and queue runtime layer.
  - Verify: queue/capture tests pass.

- [ ] **1.2** Wire flush/replay operations to native write/store actions
  - Role: typescript-coder
  - Deliverable: capture events become native writes through the existing store API.
  - Verify: flush/replay tests prove persistence and retrieval.

### Phase 2 — Hardening and docs
- [ ] **2.1** Add a restart/replay regression test to confirm session data survives runtime reset
  - Role: test-engineer
  - Deliverable: restart-safe queue regression test.
  - Verify: restart-oriented test command passes.

- [ ] **2.2** Update session-capture notes in `docs/session-memory-native-architecture.md` and related migration docs to describe the TS-native queue runtime
  - Role: documenter
  - Deliverable: migration notes for session capture and queue behavior.
  - Verify: docs align with implemented event flow.

## TDD / Verification Strategy
- RED: define event flow tests for capture, flush, replay, and restart first.
- GREEN: implement the smallest TS-native queue runtime that satisfies them.
- REFACTOR: keep queue logic separate from write semantics except at the integration boundary.
- Recommended checks: targeted session-capture tests plus a flush/replay/restart smoke test.

## Pseudocode / Design Sketch
```text
capture(event): enqueue(event)
processQueue():
  for event in queue:
    if event.kind == flush/replay/capture:
      normalize -> write(intent)
      mark processed
```

## Risks & Mitigations
- Risk: replay semantics duplicate writes or lose ordering.
  - Mitigation: use idempotent write semantics and stable event IDs.
- Risk: capture migration breaks live transcript ingestion.
  - Mitigation: preserve the current envelope shape and add restart-safe regression tests.
- Risk: Python remains in the active session-capture path by accident.
  - Mitigation: add explicit tests that assert the default runtime entry point stays on TS and that any Python fallback is disabled by default.

## Rollback
- Revert queue runtime migration if captured sessions stop persisting or become unretrievable.
- Re-enable the prior runtime wiring only through the explicit disabled-by-default compatibility escape hatch, if one exists for local recovery.

## Verification Commands
- `pytest -q tests/unit/test_session_capture*.py`
- `pytest -q tests/unit/test_queue*.py`
- `pytest -q tests/integration/test_session_capture_queue*.py`
- `pytest -q tests/unit/test_session_capture_restart*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript test command for `src/` runtime coverage

## See Also
- `docs/session-memory-native-architecture.md`
- `docs/sprint-17-ts-native-store-and-stable-identity.md`
- `docs/sprint-18-ts-native-read-path-and-retrieval-baseline.md`
- `docs/sprint-20-ts-native-write-path-and-adapter-store-actions.md`
- `docs/verification/README.md`

## Definition of Done
- [ ] TS-native session capture exists.
- [ ] Queue flush/replay flows are native.
- [ ] Restart safety is proven.
- [ ] Docs describe the new runtime path.
- [ ] The active session-capture/queue path does not invoke Python.
- [ ] Any Python fallback is offline/dev-only or disabled by default.
- [ ] Ready for Sprint 22 adapter integration and shadow validation.
