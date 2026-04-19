# Sprint 23: TS Runtime Cutover, Legacy Retirement, and Documentation Closure

## Objective
Complete the transition to the TS-native BYOMem runtime by cutting over the adapter surface, retiring legacy Python-first paths, and closing the documentation loop so the repo presents the native runtime as the definitive implementation.

## Scope
### In scope
- Switch the runtime default to the TS-native path.
- Retire or gate legacy Python-first behavior where no longer needed.
- Remove or clearly quarantine obsolete compatibility paths.
- Finalize docs, migration notes, and verification guidance.
- Prove that the active/default runtime path for store, read, search, write, session capture, queue, and adapter flows does not invoke Python.
- Keep any Python implementation surfaces offline/dev-only or behind an explicit disabled-by-default escape hatch.

## Non-goals
- New feature work unrelated to the cutover.
- Major contract or schema changes.
- Reopening parity work except for critical blockers.
- Deleting offline/dev-only Python utilities that are not part of the active runtime path.

## Dependencies
- Sprint 22 shadow validation completed with acceptable results.
- Sprints 16-21 stable and verified.
- Current documentation set and migration notes.
- A clearly defined disabled-by-default fallback or escape hatch, if any retained Python compatibility path remains.

## Investigation Summary
- The prior sprints establish the TS-native store/read/write/session-capture foundation and shadow-validation coverage; Sprint 23 is the terminal routing and cleanup step.
- The repository documentation already frames `docs/session-memory-native-architecture.md` as the desired native target, so this sprint should align the default execution path and docs with that end state.
- The final acceptance boundary must be explicit: by the end of Sprint 23, the default BYOMem runtime path for store/read/search/write/session capture/queue/adapters must not invoke Python, except for offline/dev-only code or an explicit disabled-by-default compatibility escape hatch.

## Execution Mode
Standard.
Rationale: cutover and retirement are tightly coupled, high-risk changes that should be performed in a single controlled sequence with explicit rollback points.

## Acceptance Criteria
- AC-1: The TS-native runtime is the sole active/default steady-state BYOMem runtime path.
- AC-2: Store/read/search/write/session capture/queue/adapter flows on the active path do not invoke Python.
- AC-3: Any retained Python code is offline/dev-only or behind an explicit disabled-by-default compatibility escape hatch.
- AC-4: Documentation reflects the final native-first architecture and migration outcome.
- AC-5: The repo’s primary verification guidance points to the TS-native runtime and its tests.
- AC-6: Final verification proves the default runtime path stays on TS across store/read/search/write/session capture/queue/adapter coverage.
- AC-7: Sprint 23 closure docs explicitly mark Python as non-default and non-steady-state.

## Phases & Tasks
### Phase 0 — Cutover readiness checks
- [ ] **0.1** Re-run the final shadow validation and smoke tests to confirm no critical regressions remain
  - Role: test-engineer
  - Deliverable: final readiness test evidence.
  - Verify: shadow and smoke test command results are green.

- [ ] **0.2** Add a final cutover assertion that the default runtime path does not enter Python for store/read/search/write/session capture/queue/adapter flows
  - Role: test-engineer
  - Deliverable: cutover gate test.
  - Verify: explicit no-Python-path test passes.

### Phase 1 — Runtime cutover
- [ ] **1.1** Switch adapter/runtime defaults to the TS-native path in the relevant source entry points
  - Role: typescript-coder
  - Deliverable: native default routing.
  - Verify: runtime exercises native code without shadow mode.

- [ ] **1.2** Retire or quarantine legacy Python-first implementation paths and compatibility shims that are no longer required
  - Role: typescript-coder
  - Deliverable: legacy path removal or explicit deprecation gates.
  - Verify: no active runtime path depends on the retired code.

### Phase 2 — Documentation closure and cleanup
- [ ] **2.1** Update the roadmap, sprint index, and architecture docs to mark the TS-native sequence as complete
  - Role: documenter
  - Deliverable: documentation closure pass.
  - Verify: docs consistently describe the native runtime as the source of truth.

- [ ] **2.2** Remove or update stale references to Python-first behavior in `docs/` and remaining migration notes
  - Role: documenter
  - Deliverable: final docs cleanup.
  - Verify: search the docs for obsolete phrasing and confirm it is either gone or labeled deprecated.

## TDD / Verification Strategy
- RED: preserve a final regression suite around shadow validation and smoke checks before cutover.
- GREEN: switch the default path and remove obsolete compatibility behavior only after the checks pass.
- REFACTOR: simplify remaining documentation and delete dead code where safe.
- Recommended checks: final parity/shadow suite, native smoke tests, and doc search for stale references.

## Pseudocode / Design Sketch
```text
if nativeRuntimeReady && shadowDiffsAcceptable:
  defaultRuntime = TS_NATIVE
  disable legacy path except explicit deprecated fallback
else:
  stay on legacy path and investigate blockers
```

## Risks & Mitigations
- Risk: cutover exposes an untested edge case.
  - Mitigation: preserve a documented rollback switch until final validation is complete.
- Risk: removing legacy code too aggressively breaks compatibility.
  - Mitigation: retire in stages and keep explicit disabled-by-default gates until no callers remain.
- Risk: Python remains reachable through the active default path.
  - Mitigation: add final assertions that cover store/read/search/write/session capture/queue/adapters and fail if Python is entered on the default route.

## Rollback
- Restore the legacy/default routing and re-enable any removed compatibility gates if a critical regression appears.
- Keep the disabled-by-default compatibility escape hatch available only as an explicit recovery path, not a default execution path.

## Verification Commands
- `pytest -q tests/unit/test_cutover*.py`
- `pytest -q tests/integration/test_cutover*.py`
- `pytest -q tests/unit/test_no_python_default_path*.py`
- `pytest -q tests/integration/test_store_read_search_write_session_queue_adapter_no_python*.py`
- `pytest -q tests/unit/test_shadow_validation*.py`
- `npm test -- --runInBand` or the repo’s equivalent TypeScript test command for final runtime coverage

## See Also
- `docs/session-memory-native-architecture.md`
- `docs/sprint-21-ts-session-capture-and-queue-runtime-migration.md`
- `docs/sprint-22-ts-adapter-integration-and-shadow-validation.md`
- `docs/sprint-20-ts-native-write-path-and-adapter-store-actions.md`
- `docs/verification/README.md`

## Definition of Done
- [ ] TS-native runtime is the default.
- [ ] Store/read/search/write/session capture/queue/adapter active paths do not invoke Python.
- [ ] Legacy paths are retired or explicitly deprecated.
- [ ] Documentation is closed out and consistent.
- [ ] Final verification guidance points to the native runtime.
- [ ] Any retained Python code is offline/dev-only or disabled by default.
- [ ] TS-native BYOMem completion sequence is complete.
- [ ] Sprint 23 docs describe Python only as offline/dev-only or disabled-by-default compatibility.
