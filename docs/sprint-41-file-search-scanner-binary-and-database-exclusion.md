# Sprint 41: File-Search Scanner Binary and Database Exclusion

## Objective

Harden the BYOMem file-search scanner so it excludes database and binary artifacts before indexing. The scanner should continue honoring `.gitignore`, add configurable scanner-level extension exclusions defaulting to `.db`, `.sqlite`, and `.sqlite3`, and enable binary detection by default with an explicit opt-out.

## Scope

### In Scope

- Preserve existing `.gitignore` scanner behavior.
- Add default scanner extension exclusions:
  - `.db`
  - `.sqlite`
  - `.sqlite3`
- Make scanner extension exclusions configurable through explicit runtime options and CLI/env surfaces.
- Define configuration semantics clearly:
  - unset extension list uses the safe default list (`.db`, `.sqlite`, `.sqlite3`)
  - explicitly configured extension list replaces defaults
  - matching is case-insensitive and accepts entries with or without a leading dot
- Add binary-file detection before full UTF-8 reads.
- Make binary detection configurable through explicit runtime options and CLI/env surfaces:
  - default: enabled
  - explicit toggle: off
- Update developer/user docs or runbooks for the new scanner exclusion controls.
- Ensure excluded/binary files:
  - are not inserted into `indexed_files`
  - do not create `indexed_chunks`
  - do not fail scans due to UTF-8 reads
  - count as ignored in scanner progress
  - reconcile previously indexed rows out on rescan
- Wire safe defaults through scanner entry points.

### Out of Scope

- Do not edit or rely on repo-local `.gitignore` changes.
- Do not depend on committing current native DB untracking.
- Do not replace the current `.gitignore` implementation.
- Do not redesign semantic refresh.
- Do not implement perfect MIME detection.

## Investigation Summary

Relevant implementation files:

- `ts/packages/runtime/src/file-search-db.ts`
  - `FileSearchDbOptions`
  - `walkFiles`
  - `isIgnoredFileSearchArtifact`
  - `isIgnoredInternalFile`
  - `scanAndIndexFiles`
  - `openFileSearchDb`
- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/src/file-search-active-poller.ts`
- `ts/packages/runtime/src/pi-extension.ts`
- `ts/packages/runtime/src/cli.ts`
- `ts/packages/runtime/src/index.ts`

Relevant tests:

- `ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts`
- `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`
- New test target:
  - `ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts`

Current behavior:

- Scanner already honors `.gitignore`.
- Scanner already ignores some hardcoded BYOMem/runtime artifacts.
- SQLite companions ending in `-wal` or `-shm` are already ignored.
- Current scan path can still attempt to read unignored/tracked database files as UTF-8.
- Sprint 40 exposed this with `native/native_search.db`; local mitigation was `.gitignore` plus rescan, but Sprint 41 must make the scanner robust without relying on that local state.

## Acceptance Criteria

- **AC-1:** Existing `.gitignore` behavior remains unchanged and existing `.gitignore` scanner tests pass.
- **AC-2:** By default, `.db`, `.sqlite`, and `.sqlite3` files are skipped before indexing.
- **AC-3:** Default database-extension exclusions reconcile previously indexed matching files out of `indexed_files`, `indexed_chunks`, and `file_records` on rescan.
- **AC-4:** Scanner extension exclusions are configurable through runtime options and CLI/env surfaces; an explicit configured list replaces defaults, while an omitted list uses `.db`, `.sqlite`, and `.sqlite3`.
- **AC-5:** Extension matching is case-insensitive and accepts configured entries with or without leading dots.
- **AC-6:** Binary detection is enabled by default and skips binary files before full UTF-8 reads.
- **AC-7:** Binary detection can be explicitly disabled through runtime options and CLI/env surfaces.
- **AC-8:** Expected scanner skips increase `progress.ignoredFiles` and do not increase `progress.errorFiles`.
- **AC-9:** Safe defaults apply through `openFileSearchDb`, `openNativeStore`, active poller, Pi extension direct scans, and CLI scan/search paths.
- **AC-10:** A `*.db` file in a project tree is skipped even when not ignored by `.gitignore`.
- **AC-11:** Developer/user docs describe default exclusions, custom extension list semantics, and the binary detection toggle.

## Execution Mode

**Standard / mostly serial.**

Most changes share `ts/packages/runtime/src/file-search-db.ts`, so the core scanner option and skip behavior should land before entry-point wiring. Tests should be written first.

## Workstreams

### Workstream A: RED Tests

Owner: `test-engineer`

Files:

- `ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts`

Deliverables:

- Failing tests for default database exclusions.
- Failing tests for configurable exclusions, including replace-default semantics and case-insensitive matching.
- Failing tests for binary detection default on/off behavior.
- Failing tests for reconciliation of previously indexed excluded files.
- Regression verification for `.gitignore` behavior.

### Workstream B: Scanner Core

Owner: `typescript-coder`

Files:

- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/index.ts`

Deliverables:

- New scanner option types.
- Default excluded extensions.
- Extension normalization helper.
- Binary detection helper.
- Skip logic before full content reads.
- Reconciliation-compatible behavior.

### Workstream C: Entry-Point Wiring

Owner: `typescript-coder`

Files:

- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/src/file-search-active-poller.ts`
- `ts/packages/runtime/src/pi-extension.ts`
- `ts/packages/runtime/src/cli.ts`

Deliverables:

- Safe defaults everywhere.
- Explicit override support where existing options/config patterns allow.

### Workstream D: Validation

Owner: `test-engineer`, `code-reviewer`

Deliverables:

- Targeted test pass.
- Full test/build pass.
- Review that no local `.gitignore` mitigation is required.

## Phases & Tasks

### Phase 0: Preflight and RED Tests

- [ ] **0.1** Check current local state without depending on it.
  - Role: `codebase-investigator`
  - Deliverable: Note current `.gitignore`/native DB untracking state as context only.
  - Depends on: none
  - Verify:
    ```bash
    git status --short
    ```

- [ ] **0.2** Add Sprint 41 RED test file.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts`
  - Deliverable: Tests that initially fail for missing extension/binary exclusion behavior.
  - Depends on: none
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
    ```

- [ ] **0.3** Verify existing `.gitignore` contracts still describe required behavior.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts`
  - Deliverable: No weakening of existing `.gitignore` coverage.
  - Depends on: none
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts
    ```

### Phase 1: Scanner Options and Defaults

- [ ] **1.1** Extend `FileSearchDbOptions` with scanner exclusion configuration.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Suggested options:
    - `scannerExcludedExtensions?: string[]` (unset = defaults; explicit list = replace defaults)
    - `scannerBinaryDetectionEnabled?: boolean` (unset = true)
  - Depends on: 0.2
  - Verify:
    ```bash
    npm run build
    ```

- [ ] **1.2** Add default excluded extension constants and normalization.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable:
    - defaults: `.db`, `.sqlite`, `.sqlite3`
    - unset option uses defaults
    - explicit configured list replaces defaults
    - case-insensitive matching
    - support configured extensions with or without leading `.`
  - Depends on: 1.1
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
    ```

- [ ] **1.3** Ensure public exports/types still build.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/index.ts`
  - Deliverable: New option surface available through existing exported types.
  - Depends on: 1.1
  - Verify:
    ```bash
    npm run build
    ```

### Phase 2: Extension Exclusion Behavior

- [ ] **2.1** Skip configured extension-excluded files before indexing.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: `.db`, `.sqlite`, `.sqlite3` skipped by default before content reads.
  - Depends on: 1.2
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
    ```

- [ ] **2.2** Preserve reconciliation for newly excluded files.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: Excluded files are not added to the scan `seen` set, so stale index rows are deleted.
  - Depends on: 2.1
  - Verify: Sprint 41 reconciliation tests pass.

- [ ] **2.3** Count extension-excluded files as ignored.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: `progress.ignoredFiles` includes extension skips.
  - Depends on: 2.1
  - Verify: Sprint 41 progress assertions pass.

### Phase 3: Binary Detection

- [ ] **3.1** Add binary detection helper.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: Conservative binary heuristic using a small initial byte sample.
  - Suggested behavior:
    - NUL byte means binary.
    - Optional conservative control-byte ratio.
    - Do not read entire large files for detection.
  - Depends on: 1.1
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
    ```

- [ ] **3.2** Run binary detection before full UTF-8 reads.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: Binary files are skipped without scanner failure.
  - Depends on: 3.1
  - Verify: Binary default test passes with `errorFiles === 0`.

- [ ] **3.3** Implement binary detection opt-out.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: Binary detection defaults on and can be disabled explicitly.
  - Depends on: 3.2
  - Verify: Binary opt-out test passes.

- [ ] **3.4** Ensure binary-skipped stale rows reconcile out.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: Previously indexed files later detected as binary are removed on rescan.
  - Depends on: 3.2
  - Verify: Sprint 41 binary reconciliation assertion passes.

### Phase 4: Configuration Propagation

- [ ] **4.1** Thread scanner options through native store.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/store.ts`
  - Deliverable: `openNativeStore` can pass scanner exclusions and binary toggle into `openFileSearchDb`.
  - Depends on: 1.1
  - Verify:
    ```bash
    npm run build
    ```

- [ ] **4.2** Confirm active poller uses safe defaults.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-active-poller.ts`
  - Deliverable: Poller scans inherit default exclusions/binary detection; explicit options wired if needed.
  - Depends on: 4.1
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts
    ```

- [ ] **4.3** Confirm Pi extension direct scans use safe defaults.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/pi-extension.ts`
  - Deliverable: Direct scan/status/search paths remain safe by default.
  - Depends on: 4.1
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

- [ ] **4.4** Add CLI/env scanner exclusion controls in `ts/packages/runtime/src/cli.ts`.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/cli.ts`
  - Deliverable:
    - CLI flag `--file-search-excluded-extensions <comma-separated>`
    - CLI flag `--file-search-binary-detection <true|false>`
    - Env var `BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS`
    - Env var `BYOMEM_FILE_SEARCH_BINARY_DETECTION`
    - CLI flags override env; omitted values use runtime defaults
  - Depends on: 4.1
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/cli.test.ts
    ```

- [ ] **4.5** Add Pi/YAML config parsing for scanner exclusion controls in `ts/packages/runtime/src/pi-extension.ts`.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/pi-extension.ts`
  - Deliverable:
    - YAML keys under `file_search`: `excluded_extensions` and `binary_detection`
    - Env vars override YAML for direct Pi file-search opens
    - Runtime status includes resolved scanner exclusion settings when practical
  - Depends on: 4.1, 4.4
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

### Phase 5: Docs, Validation, and Review

- [ ] **5.0** Document scanner exclusion controls.
  - Role: `documenter`
  - Files: relevant file-search runbook/docs, likely `docs/semantic-hybrid-document-search-runbook.md` or a scanner runbook if present
  - Deliverable: Docs for default database extensions, custom extension list replace semantics, binary detection default-on behavior, and opt-out controls.
  - Depends on: 4.4, 4.5
  - Verify: docs match implemented option/env/YAML names.

- [ ] **5.1** Run targeted scanner tests.
  - Role: `test-engineer`
  - Depends on: Phases 2-4
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
    npm test -- ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts
    npm test -- ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts
    npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
    ```

- [ ] **5.2** Run full build and test suite.
  - Role: `test-engineer`
  - Depends on: 5.1
  - Verify:
    ```bash
    npm run build
    npm test
    ```

- [ ] **5.3** Review local-state independence.
  - Role: `code-reviewer`
  - Deliverable: Confirm behavior does not depend on committing `.gitignore` or native DB untracking changes.
  - Depends on: 5.2
  - Verify: Review tests use temp directories and include a `*.db` fixture without `.gitignore`.

- [ ] **5.4** Review scanner skip interactions.
  - Role: `code-reviewer`
  - Deliverable: Confirm runtime artifact filters, sensitive-content filters, `.gitignore`, extension exclusions, and binary detection compose correctly.
  - Depends on: 5.2
  - Verify:
    ```bash
    npm test -- ts/packages/runtime/tests/file-search-sensitive-artifacts.test.ts
    npm test -- ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts
    ```

## Risks & Mitigations

- **Risk:** Binary detection false positives.
  - **Mitigation:** Use conservative NUL-byte-first heuristic and provide opt-out.

- **Risk:** Config semantics are unclear.
  - **Mitigation:** Sprint 41 defines exact semantics: omitted list uses defaults; explicit configured list replaces defaults; tests cover both.

- **Risk:** Excluded files remain searchable from stale rows.
  - **Mitigation:** Test reconciliation from previously indexed file to newly excluded file.

- **Risk:** `.gitignore` behavior regresses.
  - **Mitigation:** Keep and run existing Sprint 28 `.gitignore` tests.

- **Risk:** Scanner entry points diverge.
  - **Mitigation:** Keep safe defaults inside `openFileSearchDb`; wire overrides only where needed.

- **Risk:** Local repo mitigation hides the bug.
  - **Mitigation:** Use isolated temp test fixtures with no `.gitignore`.

## Definition of Done

- Sprint 41 RED tests are added before implementation.
- `.db`, `.sqlite`, and `.sqlite3` are excluded by default.
- Scanner extension exclusions are configurable through runtime options and CLI/env/Pi config surfaces.
- Configured extension list semantics are tested and documented.
- Binary detection is enabled by default.
- Binary detection can be disabled explicitly through runtime options and CLI/env/Pi config surfaces.
- Excluded/binary files are skipped before full UTF-8 reads.
- Expected skips count as ignored, not errors.
- Previously indexed excluded/binary files reconcile out on rescan.
- Existing `.gitignore` tests still pass.
- Safe defaults apply across scanner entry points.
- Docs/runbooks describe the new controls.
- Validation passes:
  ```bash
  npm test -- ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts
  npm test -- ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts
  npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
  npm test
  npm run build
  ```
- Code review confirms the solution does not depend on current uncommitted `.gitignore` or native DB untracking state.
