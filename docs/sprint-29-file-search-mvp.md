# Sprint 29: File Search MVP

## Objective
Deliver the initial file search experience on top of the indexed project-partitioned file-search DB. This sprint focuses on BM25-first retrieval and only allows semantic retrieval when it is grounded on stable indexed chunks, returning project-scoped results from the global file-search store.

## Scope
### In scope
- Implement BM25-first file search over the indexed corpus
- Return project-scoped results from the global file-search DB
- Allow semantic retrieval only when it is grounded on stable indexed chunks
- Add RED tests for query behavior, project scoping, and grounded semantic fallback
- Keep the MVP search behavior compact and predictable

### Out of scope
- Scanner/indexer logic and reconciliation
- Scheduler, freshness, and periodic refresh logic
- Watch-mode or continuous observation behavior
- Semantic retrieval that is not grounded on stable indexed chunks
- Any memories DB changes

## Dependencies
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md` — includes the stable indexed-chunk/output foundation used by semantic fallback
- `docs/README.md`
- `docs/pi-memory-roadmap.md`
- Canonical sprint template and sprint-planning workflow

## Investigation Summary
- Sprint 27 establishes the physically separate file-search DB boundary.
- Sprint 28 provides the project-partitioned indexed corpus and stable indexed chunk/output foundation that search can query.
- BM25 should be the primary retrieval mechanism for the MVP because it is grounded in the stable index.
- Semantic retrieval is allowed only when it uses the stable indexed chunks or equivalent output produced by the scanner/indexer path.
- The main risk is mixing retrieval concerns with freshness or scheduler behavior before the MVP is stable.

## Acceptance Criteria
- AC-1: File search returns project-scoped results from the global file-search DB.
- AC-2: BM25 is the first retrieval path used by the MVP.
- AC-3: Semantic retrieval is only used when it is grounded on stable indexed chunks or equivalent stable indexed output from Sprint 28.
- AC-4: Search tests cover scoped retrieval, BM25-first behavior, and the Sprint 28-gated semantic fallback.
- AC-5: RED tests define the search contract before implementation.

## Execution Mode
standard
Rationale: search ranking, project scoping, and grounded semantic fallback are closely coupled and should be implemented in a single controlled sequence.

## Phases & Tasks
### Phase 0 — RED tests and search contract
- [ ] **0.1** Add failing tests for BM25-first project-scoped file search
  - Role: test-engineer
  - Deliverable: RED tests covering scoped search results and the BM25-first retrieval path.
  - Depends on: Sprint 28 indexer MVP
  - Verify: targeted file-search test run fails before implementation.

- [ ] **0.2** Add failing tests for grounded semantic retrieval fallback on Sprint 28 stable indexed chunks or equivalent output
  - Role: test-engineer
  - Deliverable: RED tests proving semantic retrieval only participates when Sprint 28 chunk/output data is stable and indexed.
  - Depends on: 0.1
  - Verify: semantic fallback tests fail before implementation.

### Phase 1 — Search implementation
- [ ] **1.1** Implement BM25-first retrieval over the project-partitioned index
  - Role: backend-coder
  - Deliverable: search logic that ranks and returns project-scoped results from the file-search DB.
  - Depends on: 0.1
  - Verify: BM25-first search tests pass.

- [ ] **1.2** Implement grounded semantic retrieval integration for stable indexed chunks
  - Role: backend-coder
  - Deliverable: semantic fallback that only activates when the indexed chunk set is stable and valid.
  - Depends on: 0.2, 1.1
  - Verify: semantic fallback tests pass and unstable chunks are excluded.

### Phase 2 — Validation and docs
- [ ] **2.1** Document the MVP search behavior and the boundary to future freshness/scheduler work
  - Role: documenter
  - Deliverable: concise docs for BM25-first file search and grounded semantic fallback.
  - Depends on: 1.1, 1.2
  - Verify: docs review confirms the search MVP is clearly bounded.

## Verification
- Run the targeted file-search tests added in Phase 0.
- Confirm search results are project-scoped.
- Confirm BM25 remains the primary MVP retrieval path.
- Confirm semantic retrieval does not run on unstable or unindexed chunk sets.

## Risks & Mitigations
- Risk: semantic retrieval can become unstable if it is not grounded tightly enough.
  - Mitigation: require stable indexed chunks as a hard precondition.
- Risk: scope leakage could expose cross-project results.
  - Mitigation: keep `project_key` filtering mandatory in the search layer.
- Risk: overfitting the search MVP to future scheduler assumptions.
  - Mitigation: keep freshness and scheduling explicitly out of scope.

## Definition of Done
- [ ] Project-scoped file search works from the global file-search DB
- [ ] BM25-first retrieval is implemented and tested
- [ ] Semantic retrieval is grounded on stable indexed chunks only
- [ ] RED tests cover the search contract
- [ ] Docs describe the MVP behavior and the next-sprint boundary

## See Also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 27: Global File Search DB Foundation](./sprint-27-global-file-search-db-foundation.md)
- [Sprint 28: File Scanner / Indexer MVP](./sprint-28-file-scanner-indexer-mvp.md)
