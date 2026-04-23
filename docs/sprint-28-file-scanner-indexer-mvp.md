# Sprint 28: File Scanner / Indexer MVP

## Objective
Build the scanner-first file indexing MVP on top of the separate global file-search DB. This sprint focuses on discovering new and changed files, confirming content changes with a hash after mtime/size prefiltering, and reconciling new, changed, and deleted records into the project-partitioned index.

## Scope
### In scope
- Implement scanner-first file discovery for project-scoped indexing
- Use mtime/size prefiltering before content-hash confirmation
- Reconcile new, changed, and deleted files into the file-search index
- Create and store stable indexed chunks or equivalent indexed file-search output in the project-partitioned file-search DB from Sprint 27
- Add RED tests for scan detection, hash confirmation, chunk/output creation, and reconciliation behavior
- Keep indexing MVP-focused and grounded in stable filesystem state

### Out of scope
- File search query UX or ranking behavior
- Scheduler, periodic freshness, or debounce logic
- Watch-mode file observation
- Semantic retrieval unless it depends on stable indexed chunks later
- Any memories DB changes

## Dependencies
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/README.md`
- `docs/pi-memory-roadmap.md`
- Canonical sprint template and sprint-planning workflow

## Investigation Summary
- The foundation sprint establishes a physically separate file-search DB, so this sprint can focus on indexing behavior.
- Scanner-first MVP means detection should start from the filesystem, not from search-time inference.
- mtime and size provide a cheap prefilter, but content-hash confirmation is required before treating a file as changed.
- This sprint also needs to produce stable indexed chunks or equivalent chunked index output so Sprint 29 can ground any semantic retrieval on a stable indexed corpus.
- Reconciliation must handle additions, modifications, and deletions so the index stays in sync with the project tree.
- The most likely risk is over-indexing from noisy metadata changes or under-indexing when deletions are missed.

## Acceptance Criteria
- AC-1: The scanner discovers files for a project and records new entries in the file-search index.
- AC-2: mtime/size prefiltering avoids unnecessary full-content work, while content-hash confirmation determines whether a file is truly changed.
- AC-3: The indexer creates and stores stable indexed chunks or equivalent stable indexed output suitable for later search-time use.
- AC-4: Index reconciliation correctly handles new, changed, and deleted files.
- AC-5: Indexed data is written to the project-partitioned file-search DB from Sprint 27.
- AC-6: RED tests define the scanner/indexer contract before implementation.

## Execution Mode
standard
Rationale: the scanner, hash confirmation, and reconciliation steps are tightly coupled and should land in a single controlled sequence.

## Phases & Tasks
### Phase 0 — RED tests and indexing contract
- [ ] **0.1** Add failing tests for scanner-first discovery, mtime/size prefiltering, and hash confirmation
  - Role: test-engineer
  - Deliverable: RED tests covering scan discovery, cheap prefiltering, and content-hash confirmation.
  - Depends on: Sprint 27 foundation
  - Verify: targeted scanner/indexer test run fails before implementation.

- [ ] **0.2** Add failing tests for new/changed/deleted reconciliation in the file-search index
  - Role: test-engineer
  - Deliverable: RED tests for index reconciliation across add, modify, and delete cases.
  - Depends on: 0.1
  - Verify: reconciliation tests fail before implementation.

### Phase 1 — Scanner/indexer implementation
- [ ] **1.1** Implement scanner-first discovery and mtime/size prefiltering
  - Role: backend-coder
  - Deliverable: discovery logic that identifies candidate files efficiently before hash confirmation.
  - Depends on: 0.1
  - Verify: scanner tests pass for discovery and prefiltering.

- [ ] **1.2** Implement stable chunk/output creation and content-hash confirmation for discovered files
  - Role: backend-coder
  - Deliverable: stable indexed chunks or equivalent indexed output derived from confirmed file content.
  - Depends on: 0.2, 1.1
  - Verify: chunk/output creation tests pass and confirmed content is stored in stable indexed form.

- [ ] **1.3** Implement index reconciliation for new, changed, and deleted files
  - Role: backend-coder
  - Deliverable: indexer logic that updates the file-search index accordingly.
  - Depends on: 1.2
  - Verify: reconciliation tests pass and deleted files are removed from the index.

### Phase 2 — Validation and docs
- [ ] **2.1** Document the scanner-first MVP flow and the boundaries for later search work
  - Role: documenter
  - Deliverable: concise docs describing scanner-first indexing, prefiltering, and reconciliation.
  - Depends on: 1.1, 1.2
  - Verify: docs review confirms the MVP scope is clearly bounded.

## Verification
- Run the targeted scanner/indexer tests added in Phase 0.
- Confirm mtime/size prefiltering reduces unnecessary hash work while hash confirmation gates true changes.
- Confirm stable indexed chunks or equivalent stable indexed output are created and stored for later search use.
- Confirm new, changed, and deleted files are reconciled into the project partition correctly.

## Risks & Mitigations
- Risk: noisy filesystem metadata can cause churn.
  - Mitigation: keep hash confirmation mandatory before declaring a file changed.
- Risk: deleted-file reconciliation can lag behind discovery.
  - Mitigation: include explicit deletion handling in the MVP contract and tests.
- Risk: indexing logic could drift from the physically separate DB boundary.
  - Mitigation: keep all writes routed through the Sprint 27 file-search store layer.

## Definition of Done
- [ ] Scanner-first discovery works for project files
- [ ] mtime/size prefiltering and content-hash confirmation are both covered by tests
- [ ] New, changed, and deleted files reconcile into the index correctly
- [ ] Indexed data lives in the project-partitioned file-search DB
- [ ] Docs describe the MVP flow and its next-step boundary

## See Also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 27: Global File Search DB Foundation](./sprint-27-global-file-search-db-foundation.md)
