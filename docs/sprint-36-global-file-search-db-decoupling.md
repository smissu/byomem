# Sprint 36: Global File Search DB Decoupling

## Objective
Decouple BYOMem file-search database storage from the scanned project root so file-search uses one global physical SQLite database by default while still scanning arbitrary project directories. This aligns the implementation with the original global file-search architecture: future schema/features/migrations should be applied in one global location, not separately in every project checkout.

## User Rationale
The current CLI behavior writes `byomem-file-search.sqlite` inside the scanned project when users run commands such as:

```bash
npm run byomem:cli -- file-search-scan --base-dir /path/to/project
```

That does not scale across many projects. If the file-search/scan app gains new schema, indexing, status, semantic, or scheduler features, every project-local DB would need to be found and upgraded. A global file-search DB keeps the physical storage and migrations centralized while preserving logical `project_key` partitioning per scanned project.

## Scope
### In scope
- Split file-search concepts that are currently overloaded as `baseDir`:
  - **scan root / project root**: the directory to walk, index, derive `project_key` from, and report as scanner `baseDir`.
  - **DB storage location**: the physical SQLite path for `byomem-file-search.sqlite`, global by default.
- Add a canonical global file-search DB resolver, likely under the BYOMem runtime/storage root such as `~/.byomem/runtime/byomem-file-search.sqlite`.
- Update runtime/CLI file-search commands so `--base-dir <project>` means "scan/search this project", not "store the file-search DB in this project".
- Preserve existing project partitioning by `project_key` inside the single global DB.
- Preserve explicit file-search DB path override support for tests, development, and legacy/local troubleshooting.
- Update scan, status, scheduler, and query paths together so they consistently use scan root for project identity and global path for storage.
- Add TDD-first RED tests for global default location, cross-project partitioning, query isolation, status semantics, and compatibility behavior.
- Document behavior for legacy project-local `byomem-file-search.sqlite` files.

### Out of scope
- Cross-project aggregate search UX. This sprint preserves current project-scoped search behavior.
- Automatic migration/import of every existing project-local file-search DB.
- Scheduler redesign, watchers, daemons, or background scanning.
- Semantic ranking/model changes.
- Memory/native store relocation beyond the minimum file-search plumbing needed to stop storing file-search DBs in each scanned project.
- Destructive deletion of legacy project-local DBs.

## Investigation Summary
- `openNativeStore({ baseDir })` in `ts/packages/runtime/src/store.ts` currently passes the same `baseDir` into `openFileSearchDb(...)`.
- `openFileSearchDb(...)` in `ts/packages/runtime/src/file-search-db.ts` currently resolves the DB path as `resolve(options.baseDir, 'byomem-file-search.sqlite')`.
- The scanner also walks `options.baseDir` and derives `project_key` from it, so storage location, scan root, and project identity are coupled.
- `file-search-query.ts` scopes search via `store.baseDir`, so query scoping must be updated with the same scan-root concept as the scanner.
- The schema already stores `project_key` on file-search rows and `file_search_scanner_status`, which supports one global DB partitioned by project.
- Sprint 34 added `file-search-scan`; Sprint 35 added `file-search --limit`. Their CLI tests currently expect project-local DB behavior in some cases and must be updated.
- Existing Sprint 27 docs called the file-search DB "global" conceptually, but current implementation made it physically local when callers used project `baseDir`.

## Acceptance Criteria
- [x] **AC36-1:** Default file-search DB storage is global, not project-local. Running `file-search-scan --base-dir <project>` does not create `<project>/byomem-file-search.sqlite` by default.
- [x] **AC36-2:** Scan root remains the provided project directory. The scanner walks `--base-dir <project>`, records scanner status `baseDir` as that project path, and derives `project_key` from that project path, not from the global DB directory.
- [x] **AC36-3:** Two different project roots can scan into the same physical global file-search DB without path collisions, row overwrites, or project-key leakage.
- [x] **AC36-4:** Project-scoped `file-search` queries return only results for the current scan/search project even when multiple projects share the same global DB.
- [x] **AC36-5:** `file-search-status --base-dir <project>` reads the status partition for that project from the global DB without scanning and without reporting the global DB directory as the scanned project.
- [x] **AC36-6:** Explicit file-search DB path override remains supported for tests/dev/legacy use and still enforces guards against memories DB paths (`byomem-index.sqlite`, `native-store.json`) and unsafe collisions.
- [x] **AC36-7:** Legacy project-local `byomem-file-search.sqlite` behavior is deterministic and documented: the new default ignores local DBs unless an explicit override points to them; no automatic destructive migration or deletion occurs in this sprint.
- [x] **AC36-8:** If the explicit DB path is inside the scanned project by override, internal DB files and SQLite companions remain ignored by the scanner.
- [x] **AC36-9:** Existing Sprint 27–35 file-search scanner/search/status/CLI regressions remain green after expectation updates.
- [x] **AC36-10:** Documentation explains the new global location, override behavior, legacy local DB handling, and why global DB storage reduces per-project migration burden.

## Execution Mode
standard

Rationale: the change touches shared file-search open/query/status plumbing. Most implementation tasks converge on `file-search-db.ts`, `store.ts`, and `cli.ts`, so broad parallel edits would risk conflicts. Tests/docs can be staged around the central contract change.

## Proposed API / Contract Direction
Names should be locked by RED tests before implementation, but the code should move toward explicit concepts such as:

```ts
interface FileSearchDbOptions {
  // Directory to scan and use for project identity/status baseDir.
  projectBaseDir: string;

  // Physical SQLite file path or storage root for the global file-search DB.
  dbFile?: string;
  dbBaseDir?: string;
}
```

or equivalent names. The important contract is:

- scan/query/status identity comes from project/scan root;
- physical DB path comes from global runtime storage by default;
- explicit overrides are named as DB storage overrides, not confused with project scan root.

For `openNativeStore(...)`, add file-search-specific options rather than continuing to overload `baseDir`, for example:

```ts
interface NativeStoreOptions {
  baseDir: string; // native memory/runtime store root
  fileSearchProjectBaseDir?: string; // scanned project root
  fileSearchDbFile?: string; // explicit physical DB override
  fileSearchDbBaseDir?: string; // explicit storage root override
}
```

The exact names can differ, but tests should prevent recoupling.

## Compatibility / Migration Policy
- No automatic migration of existing project-local `byomem-file-search.sqlite` files in Sprint 36.
- New default behavior uses the global DB path and rebuilds/reindexes project partitions there on the next scan/search.
- File-search project keys now include a short canonical project-root hash to avoid same-basename collisions in the global DB. Older rows/status partitions keyed only as `project:<basename>` are not migrated in Sprint 36 and will be ignored/rebuilt under the new hash-suffixed key on the next scan.
- Existing local DBs are left in place and ignored by default.
- Users/tests can opt into a local/legacy DB only by explicit DB path override.
- A future migration/import sprint may add safe import tooling if needed.

## Phases & Tasks
### Phase 0 — RED Tests / Contract Locking
- [x] **0.1** Add failing default-global-path tests in `ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts`.
  - Role: test-engineer
  - Deliverable: tests proving file-search DB path is not `<project>/byomem-file-search.sqlite` by default and resolves to the global runtime/storage location.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts` fails before implementation.

- [x] **0.2** Add failing scan-root-vs-DB-location tests.
  - Role: test-engineer
  - Deliverable: tests proving scanner walks `projectBaseDir`, scanner status reports project `baseDir`, and `project_key` derives from project root while DB file lives elsewhere.
  - Depends on: 0.1
  - Verify: focused Sprint 36 test fails before implementation.

- [x] **0.3** Add failing cross-project partition/query isolation tests.
  - Role: test-engineer
  - Deliverable: tests that scan two temp project roots into one physical DB and prove project A search/status cannot see project B rows.
  - Depends on: 0.1
  - Targets: `ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts`, possibly `sprint-29-file-search-mvp.test.ts`.
  - Verify: focused tests fail before query/scanner plumbing is updated.

- [x] **0.4** Add failing CLI default-global-location tests.
  - Role: test-engineer
  - Deliverable: CLI tests proving `file-search-scan --base-dir <project>` indexes project files but does not create `<project>/byomem-file-search.sqlite`, and `file-search --base-dir <project>` queries the shared global DB partition.
  - Depends on: 0.1, 0.3
  - Target: `ts/packages/runtime/tests/cli.test.ts` or focused Sprint 36 CLI test.
  - Verify: CLI tests fail before implementation.

- [x] **0.5** Add failing override/guard compatibility tests.
  - Role: test-engineer
  - Deliverable: tests proving explicit DB path override works, guards still reject memories DB/snapshot paths, and explicit local override keeps scanner ignoring DB companion files.
  - Depends on: 0.1
  - Targets: `sprint-27-file-search-db-foundation.test.ts`, Sprint 36 test file.
  - Verify: tests fail before new option plumbing.

- [x] **0.6** Add failing no-side-effect validation tests for invalid `file-search` inputs if not already covered.
  - Role: test-engineer
  - Deliverable: tests for missing `--query` and invalid `--mode` proving no project-local or global file-search DB is created/opened when validation fails.
  - Depends on: none
  - Target: `ts/packages/runtime/tests/cli.test.ts`.
  - Verify: targeted CLI tests fail until validation-path expectations are complete.

### Phase 1 — Path Resolver and API Split
- [x] **1.1** Add a canonical global file-search DB path resolver.
  - Role: typescript-coder
  - Deliverable: helper that resolves default global `byomem-file-search.sqlite` under the BYOMem runtime/storage root, creates parent directories safely, and can be reused by CLI/runtime tests.
  - Depends on: 0.1
  - Likely files: `ts/packages/runtime/src/file-search-db.ts` or new `ts/packages/runtime/src/runtime-paths.ts`.
  - Verify: default-global-path tests begin passing.

- [x] **1.2** Split `openFileSearchDb(...)` options into scan root and DB storage location.
  - Role: typescript-coder
  - Deliverable: file-search DB can be opened with `projectBaseDir`/scan root separate from physical `dbFile`/storage root; scanner status `baseDir` remains project root.
  - Depends on: 1.1, 0.2
  - Likely file: `ts/packages/runtime/src/file-search-db.ts`.
  - Verify: scan-root-vs-DB-location tests pass.

- [x] **1.3** Update file-search boundary guards for explicit DB paths.
  - Role: typescript-coder
  - Deliverable: guards reject memories DB/snapshot paths whether overrides are absolute or relative, and still protect DB companion files from scanning.
  - Depends on: 1.2, 0.5
  - Likely file: `ts/packages/runtime/src/file-search-db.ts`.
  - Verify: Sprint 27 foundation and Sprint 36 override tests pass.

### Phase 2 — Runtime / CLI / Query Integration
- [x] **2.1** Thread scan-root and DB-location options through `openNativeStore(...)`.
  - Role: typescript-coder
  - Deliverable: `NativeStoreOptions` supports file-search scan root and DB storage override without recoupling them to `baseDir`; `NativeStore` exposes enough scan-root context for search scoping.
  - Depends on: 1.2
  - Likely file: `ts/packages/runtime/src/store.ts`.
  - Verify: runtime decoupling tests pass.

- [x] **2.2** Update `file-search-query.ts` to scope by file-search project root/project key, not native store storage root.
  - Role: typescript-coder
  - Deliverable: project-scoped search uses the same project identity as scanner/status when DB is global.
  - Depends on: 2.1, 0.3
  - Likely files: `ts/packages/runtime/src/file-search-query.ts`, `store.ts`.
  - Verify: cross-project query isolation tests pass.

- [x] **2.3** Update CLI file-search commands to use global DB by default.
  - Role: typescript-coder
  - Deliverable: `file-search`, `file-search-scan`, and `file-search-status` treat `--base-dir` as project root and open file-search DB at global default path; optional explicit DB override can be added if exposed publicly.
  - Depends on: 2.1, 2.2, 0.4
  - Likely file: `ts/packages/runtime/src/cli.ts`.
  - Verify: CLI Sprint 34/35/36 tests pass.

- [x] **2.4** Update scheduler/status interactions for global DB.
  - Role: typescript-coder
  - Deliverable: scheduler-triggered scans use project scan root for `project_key` and status trigger/source; status reads remain per-project and no-scan.
  - Depends on: 2.1
  - Likely files: `file-index-scheduler.ts`, `file-search-db.ts`.
  - Verify: Sprint 30 scheduler and Sprint 33 status tests pass.

### Phase 3 — Docs / Regression / Closeout
- [x] **3.1** Update Sprint 27 foundation docs and runbook language.
  - Role: documenter
  - Deliverable: docs explain physically global file-search DB, `project_key` partitioning, and distinction between project scan root and DB storage root.
  - Depends on: implementation stable.
  - Files: `docs/sprint-27-global-file-search-db-foundation.md`, `docs/semantic-hybrid-document-search-runbook.md`.
  - Verify: docs match implemented behavior.

- [x] **3.2** Update docs index and roadmap with Sprint 36.
  - Role: documenter
  - Deliverable: links in `docs/README.md` and `docs/pi-memory-roadmap.md`.
  - Depends on: 0.1 / sprint artifact creation.
  - Verify: docs links resolve.

- [x] **3.3** Run targeted file-search regression.
  - Role: test-engineer
  - Deliverable: Sprint 27–36 file-search tests pass.
  - Depends on: Phase 2 complete.
  - Verify:
    ```bash
    npm test -- --run \
      ts/packages/runtime/tests/sprint-27-file-search-db-foundation.test.ts \
      ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts \
      ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts \
      ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts \
      ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts \
      ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts \
      ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts \
      ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts \
      ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
      ts/packages/runtime/tests/cli.test.ts \
      ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts
    ```

- [x] **3.4** Run full validation and independent review.
  - Role: test-engineer + code-reviewer
  - Deliverable: full suite/build green and review sign-off.
  - Depends on: 3.3
  - Verify:
    ```bash
    npm test -- --run
    npm run build
    git diff --check
    ```

## Risks & Mitigations
- **Risk: project scoping drift.** Moving the DB global while leaving query/status code tied to native store `baseDir` could leak or hide results.
  - Mitigation: RED tests for two projects sharing one DB with strict project-scoped search/status assertions.

- **Risk: legacy local DB/key split-brain.** Existing project-local DBs or old global rows keyed as plain `project:<basename>` may appear stale or confusing after defaults move global and file-search keys gain path hashes.
  - Mitigation: deterministic policy: ignore local DB and old key partitions by default; allow explicit DB override for local DB troubleshooting; document that first global scan rebuilds index in the global DB under the new key; no destructive deletion.

- **Risk: memories DB collision.** New path options could accidentally point file-search at `byomem-index.sqlite` or `native-store.json`.
  - Mitigation: update existing boundary guards and tests for absolute/relative overrides.

- **Risk: global DB grows large across many projects.** One physical DB centralizes migrations but increases size/contention risk.
  - Mitigation: preserve `project_key` indexes; keep cross-project aggregate UX out of scope; future retention/compaction can build on global placement.

- **Risk: environment-specific path assumptions.** Tests must not depend on the real user home or mutate `~/.byomem`.
  - Mitigation: use env overrides/temp runtime dirs in tests; expose resolver override points.

- **Risk: scheduler semantics.** Scheduler currently owns one `FileSearchDbHandle`/baseDir. Global DB should not make scheduler scan the global DB directory.
  - Mitigation: update scheduler tests to assert scan root remains project root.

## Resolved Decisions / Follow-Up Questions
- **Resolved:** the default global file-search DB path is `${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite`.
- **Follow-up:** decide whether CLI should expose an explicit flag such as `--file-search-db`, or keep the override API/test-only for now.
- **Follow-up:** decide whether a future sprint should add a migration/import command for legacy project-local file-search DBs.
- **Resolved:** memory `store`/`search` CLI commands keep current `--base-dir` storage semantics; Sprint 36 changes only file-search DB storage behavior.

## Implementation Summary
Sprint 36 decoupled file-search storage from scan roots by adding explicit file-search DB storage options and a global default resolver. `openFileSearchDb()` now uses `baseDir`/`projectBaseDir` as the scan and project-identity root while resolving the physical SQLite path from `dbBaseDir`/`dbFile` or `${BYOMEM_RUNTIME_BASE_DIR:-~/.byomem/runtime}/byomem-file-search.sqlite`. File-search project keys now include the normalized project leaf plus a short hash of the canonical project root path, preventing same-basename project collisions in the shared global DB. `openNativeStore()` now threads file-search-specific scan/storage options and exposes `fileSearchProjectBaseDir` so `file-search-query.ts` scopes searches using the same project identity as scanner/status. CLI `file-search`, `file-search-scan`, and `file-search-status` therefore use a global file-search DB by default while preserving project-scoped results.

New Sprint 36 tests cover global default path resolution, scan-root/status semantics, two same-basename projects sharing one DB without query leakage, CLI no project-local DB creation, explicit DB storage overrides, memories-DB guard compatibility, and invalid query/mode no-DB side effects. Existing file-search tests were isolated from the real user runtime path by using temp `BYOMEM_RUNTIME_BASE_DIR` values where needed.

## Verification
Verification after implementation:

```bash
npm test -- --run ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts
npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts
npm test -- --run ts/packages/runtime/tests/sprint-27-file-search-db-foundation.test.ts ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts
npm test -- --run
npm run build
git diff --check
```

## Definition of Done
- [x] Sprint 36 artifact is linked from docs index and roadmap.
- [x] File-search DB defaults to a global physical path independent of scanned project root.
- [x] CLI file-search scan/search/status do not create project-local `byomem-file-search.sqlite` by default.
- [x] Scanner/status/query project identity derives from scanned project root.
- [x] Two projects can share one global DB without search/status leakage.
- [x] Explicit DB override and memories-DB guards are tested.
- [x] Legacy local DB behavior is documented and non-destructive.
- [x] Sprint 27–36 file-search regression passes.
- [x] Full test suite and build pass.
- [x] Independent code review signs off.
