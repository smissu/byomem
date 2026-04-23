# Sprint 30: File Index Scheduler and Hardening

## Objective
Add scheduler-driven freshness and hardening on top of the file-search MVP. This sprint covers activation-triggered indexing, debounced post-activity refresh, and a periodic backstop for 1–3 active projects, while explicitly deferring watcher-based continuous monitoring.

## Scope
### In scope
- Implement activation-triggered indexing for active projects
- Add debounced post-activity refresh for recent file changes
- Add a periodic backstop to keep file indexes fresh
- Support 1–3 active projects in the scheduler model
- Harden scheduling, freshness, and failure handling around the existing scanner/indexer/search stack
- Add RED tests for activation, debounce, backstop, and multi-project freshness behavior
- Document the supported freshness model and its constraints

### Out of scope
- Watcher-based continuous file monitoring
- Scanner/indexer MVP behavior beyond stability fixes
- Search ranking changes unrelated to freshness/hardening
- File-search DB schema redesign
- Any memories DB changes

## Dependencies
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-29-file-search-mvp.md`
- `docs/README.md`
- `docs/pi-memory-roadmap.md`
- Canonical sprint template and sprint-planning workflow

## Investigation Summary
- Sprint 27 through Sprint 29 establish the DB, scanner/indexer, and search MVP layers.
- This sprint should only make those layers fresher and more reliable; it should not introduce watcher-based continuous monitoring.
- The scheduler must stay small enough to support 1–3 active projects without turning into a general daemon system.
- The main risk is over-scoping into full watch-mode behavior or too many projects before the scheduler is proven.

## Acceptance Criteria
- AC-1: Active-project activation triggers indexing for the supported project set.
- AC-2: Post-activity refresh is debounced so rapid changes do not cause redundant work.
- AC-3: A periodic backstop refreshes stale indexes even when activation signals are missed.
- AC-4: The scheduler supports 1–3 active projects in the MVP scope.
- AC-5: Failure handling is resilient enough that scheduler refresh does not wedge the file-search pipeline after a missed signal, retry, or transient error.
- AC-6: Watcher-based continuous monitoring remains deferred and out of scope.
- AC-7: RED tests cover activation, debounce, backstop, and multi-project freshness behavior.

## Execution Mode
standard
Rationale: scheduler timing, freshness policy, and hardening behavior are tightly coupled and should be implemented in a single controlled sequence.

## Phases & Tasks
### Phase 0 — RED tests and scheduler contract
- [ ] **0.1** Add failing tests for activation-triggered indexing and debounced post-activity refresh
  - Role: test-engineer
  - Deliverable: RED tests for activation and debounce behavior around recent file activity.
  - Depends on: Sprints 28 and 29 foundations
  - Verify: targeted scheduler tests fail before implementation.

- [ ] **0.2** Add failing tests for periodic backstop freshness and 1–3 active project support
  - Role: test-engineer
  - Deliverable: RED tests for backstop refresh timing and multi-project scheduling limits.
  - Depends on: 0.1
  - Verify: backstop and multi-project tests fail before implementation.

### Phase 1 — Scheduler implementation
- [ ] **1.1** Implement activation-triggered and debounced post-activity scheduling
  - Role: backend-coder
  - Deliverable: scheduler behavior that refreshes indexes after activation and change bursts.
  - Depends on: 0.1
  - Verify: activation and debounce tests pass.

- [ ] **1.2** Implement periodic backstop freshness for 1–3 active projects
  - Role: backend-coder
  - Deliverable: limited scheduler loop that keeps small project sets fresh without watcher behavior.
  - Depends on: 0.2, 1.1
  - Verify: backstop and multi-project tests pass.

### Phase 2 — Hardening and docs
- [ ] **2.1** Add failure handling and resilience checks around scheduler-driven refresh
  - Role: backend-coder
  - Deliverable: hardening for missed signals, retries, and safe degradation.
  - Depends on: 1.1, 1.2
  - Verify: scheduler failure-path tests pass.

- [ ] **2.2** Update docs to describe the supported freshness model and explicitly defer watcher-based monitoring
  - Role: documenter
  - Deliverable: concise docs covering activation, debounce, backstop, and the watcher deferral.
  - Depends on: 2.1
  - Verify: docs review confirms watcher behavior is still deferred.

## Verification
- Run the targeted scheduler/freshness tests added in Phase 0.
- Confirm activation-triggered indexing works for the supported project set.
- Confirm rapid activity is debounced.
- Confirm the periodic backstop refreshes stale indexes.
- Confirm watcher-based continuous monitoring remains out of scope.

## Risks & Mitigations
- Risk: scheduler behavior could drift into full watch-mode semantics.
  - Mitigation: keep continuous monitoring explicitly out of scope and test only activation/debounce/backstop behavior.
- Risk: too many active projects would complicate the MVP.
  - Mitigation: hard-cap the scheduler model to 1–3 active projects.
- Risk: missed refresh signals could leave stale results.
  - Mitigation: include a periodic backstop and failure-path tests.

## Definition of Done
- [ ] Activation-triggered indexing works for active projects
- [ ] Debounced post-activity refresh is implemented and tested
- [ ] Periodic backstop freshness is implemented for 1–3 active projects
- [ ] Watcher-based monitoring remains deferred
- [ ] RED tests cover the scheduler contract
- [ ] Docs describe the supported freshness model and its limits

## See Also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 27: Global File Search DB Foundation](./sprint-27-global-file-search-db-foundation.md)
- [Sprint 28: File Scanner / Indexer MVP](./sprint-28-file-scanner-indexer-mvp.md)
- [Sprint 29: File Search MVP](./sprint-29-file-search-mvp.md)
