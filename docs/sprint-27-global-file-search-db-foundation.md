# Sprint 27: Global File Search DB Foundation

## Objective
Establish the global file-search database foundation as a physically separate store from the memories DB. This sprint creates the schema, migrations, and boundary guards needed to support project-partitioned file search without mixing file-search data into the memory store. Sprint 36 later completed the physical decoupling so the default file-search DB now lives under the global runtime directory instead of each scanned project root.

## Scope
### In scope
- Create the global file-search DB as a separate physical database from the memories DB
- Current default after Sprint 36: `${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite`; scanned project roots are partitioned by `project_key` inside that DB
- Define the initial file-search schema and migrations
- Partition file-search records by `project_key`
- Add physical boundary guards that prevent file-search code from reading or writing the memories DB
- Add RED tests for separation, schema shape, and boundary enforcement
- Document the new file-search DB boundary and its relationship to the existing memory store

### Out of scope
- File scanning/indexing logic
- Search ranking or retrieval UX
- Scheduler, freshness, or watch-mode behavior
- Cross-project search aggregation beyond global DB partitioning
- Automatic migration/deletion of legacy project-local `byomem-file-search.sqlite` files
- Any memory-store schema changes unrelated to the file-search foundation

## Dependencies
- `docs/README.md`
- `docs/pi-memory-roadmap.md`
- `docs/sprint-24-global-store-project-partitioning-queue-first-single-writer.md`
- `docs/sprint-25-ts-memory-processing-observer.md`
- `docs/sprint-26-ts-memory-processing-observer-watch-mode.md`
- Canonical sprint template and sprint-planning workflow

## Investigation Summary
- The BYOMem memory store already has a global, queue-first, single-writer shape; file search must not reuse that database physically.
- Sprint 36 separates scan/search project roots from physical file-search DB storage: `--base-dir` identifies the project; DB storage defaults to the global runtime directory.
- File search is intended to be global at the DB level but logically partitioned by `project_key`.
- The main risk is accidental coupling between the memories schema and the new file-search schema.
- This sprint should establish the database boundary first so later scanner/indexer and search work can build on a stable foundation.

## Acceptance Criteria
- AC-1: File-search data is stored in a database that is physically separate from the memories DB.
- AC-2: File-search records are partitioned by `project_key` and can be addressed within that boundary.
- AC-3: Schema and migration tests verify the new file-search DB can be created and migrated independently of the memories DB.
- AC-4: Boundary guards fail fast if file-search code attempts to use the memories DB path.
- AC-5: RED tests define the separation and schema contract before implementation.

## Execution Mode
standard
Rationale: this is a shared-foundation sprint with a small number of tightly coupled schema and boundary tasks.

## Phases & Tasks
### Phase 0 — RED tests and contract definition
- [ ] **0.1** Add failing tests for physical DB separation and project-key partitioning in the file-search test suite
  - Role: test-engineer
  - Deliverable: RED tests proving the file-search DB is separate from memories DB and keyed by `project_key`.
  - Depends on: none
  - Verify: targeted test run fails before implementation.

- [ ] **0.2** Add failing migration and boundary-guard tests for file-search DB ownership
  - Role: test-engineer
  - Deliverable: RED tests covering independent migration, boundary enforcement, and fail-fast behavior on memories DB access.
  - Depends on: 0.1
  - Verify: targeted migration/boundary tests fail before implementation.

### Phase 1 — Foundation implementation
- [ ] **1.1** Implement the separate file-search DB initialization and schema migrations
  - Role: backend-coder
  - Deliverable: new file-search DB setup, schema, and migration path independent of the memories DB.
  - Depends on: 0.1, 0.2
  - Verify: file-search schema tests pass and memories DB remains unchanged.

- [ ] **1.2** Implement physical boundary guards between file-search and memories storage paths
  - Role: backend-coder
  - Deliverable: guardrails that ensure file-search code cannot read/write the memories DB.
  - Depends on: 1.1
  - Verify: boundary-guard tests pass.

### Phase 2 — Documentation and validation
- [ ] **2.1** Update roadmap/index docs to describe the file-search DB boundary and next-sprint handoff
  - Role: documenter
  - Deliverable: concise documentation of the separate file-search store and its partition model.
  - Depends on: 1.1, 1.2
  - Verify: docs review confirms the file-search DB is described as physically separate from memories.

## Verification
- Run the targeted file-search DB tests added in Phase 0.
- Run schema/migration tests for the file-search store.
- Confirm no memories DB path is used by file-search initialization or guards.

## Risks & Mitigations
- Risk: file-search foundation code may accidentally share memory-store helpers.
  - Mitigation: add boundary tests first and keep file-search initialization in a separate module.
- Risk: schema coupling could make later indexing/search work harder to evolve.
  - Mitigation: keep the initial schema minimal and partition-centric.
- Risk: unclear DB ownership could blur the separation boundary.
  - Mitigation: document the physical separation explicitly in this sprint and the roadmap.

## Sprint 36 update
Sprint 36 completed the physical-location side of this foundation: file-search DB storage now defaults to a global runtime location instead of the scanned project root, while rows remain partitioned by `project_key`. `--base-dir` and `FileSearchDbOptions.baseDir` identify the project scan/search root; the physical DB path defaults to `${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite` unless an explicit file-search DB storage override is provided. Legacy project-local `byomem-file-search.sqlite` files are not automatically migrated or deleted.

## Definition of Done
- [ ] File-search DB exists as a separate physical store from memories DB
- [ ] Project-key partitioning is defined and tested
- [ ] Independent migration path is covered by tests
- [ ] Boundary guards prevent memories DB access from file-search code
- [ ] Docs/roadmap mention the new foundation and its handoff to the next sprint

## See Also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
