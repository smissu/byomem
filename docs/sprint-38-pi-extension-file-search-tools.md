# Sprint 38: Pi Extension File-Search Tools

## Objective
Expose BYOMem file-search and scanner operations as direct Pi extension tools, analogous to the existing memory tools (`byomem_search`, `byomem_store`, `byomem_prune`). Agents in any project should be able to search indexed files, inspect scanner status, explicitly trigger a scanner run after making file edits, and manage the file-search project registry without shelling through the BYOMem CLI.

## User Rationale
The Sprint 37 global skill can teach agents how to use the CLI, but direct tools are more sustainable across context resets and across projects because they are discoverable in Pi's tool manifest. File-search should therefore be available through stable tool names just like memory search. The scanner also needs direct status and explicit scan-trigger tools so agents can refresh the index after known file changes without relying on hidden polling, watchers, or automatic scans.

## Scope
### In scope
- Add direct Pi extension tools in `ts/packages/runtime/src/pi-extension.ts`:
  - `byomem_file_search`
  - `byomem_file_search_status`
  - `byomem_file_search_scan`
  - `byomem_file_search_project_register`
  - `byomem_file_search_project_list`
  - `byomem_file_search_project_unregister`

Sprint 39 adds polling-specific tools alongside these Sprint 38 tools:

- `byomem_file_search_polling_status`
- `byomem_file_search_polling_enable`
- `byomem_file_search_polling_disable`

The original Sprint 38 search/status/scan/registry tools remain non-polling by default; only the Sprint 39 polling-specific enable tool starts a session-owned timer.
- Keep the tool style similar to existing memory tools:
  - registered via `pi.registerTool(...)`
  - strict JSON parameter schemas
  - `content[0].text` JSON plus `details` object return shape
  - normalized validation before runtime calls
- Define active-project and `baseDir` semantics so tools work from any project session.
- Ensure direct tools use global file-search DB storage while target project identity comes from the active project or explicit `baseDir`.
- Add an explicit manual scan tool that agents may call after they change files and want the scanner to pick up changes sooner.
- Add scanner status tool that reads status without scanning.
- Preserve Sprint 37 explicit registry semantics: no auto-registration from memories, searches, scans, or saved DB files.
- Update docs and the global `file-search-project-registration` skill to prefer direct tools and use CLI only as fallback.

### Out of scope
- Background polling loop implementation. (Implemented later in Sprint 39 as explicit active-project polling tools only, not hidden polling in Sprint 38 tools.)
- Filesystem watchers/daemons.
- Automatic rescans after every file edit.
- Cross-project aggregate search UX.
- Auto-registration from memory operations or existing memory records.
- Semantic embedding refresh tooling unless already required by the existing file-search runtime path.
- Deleting the CLI; CLI remains a debug/fallback surface.

## Investigation Summary
- Current direct BYOMem Pi tools live in `ts/packages/runtime/src/pi-extension.ts` and register:
  - `byomem_runtime_status`
  - `byomem_search`
  - `byomem_store`
  - `byomem_prune`
- Existing extension tests live in `ts/packages/runtime/tests/byomem-extension-wiring.test.ts` and assert tool names, parameter schemas, and selected execution behavior.
- File-search runtime APIs already exist:
  - `openFileSearchDb(...)`
  - `openFileSearchRegistryDb(...)`
  - `searchFileIndex(...)`
  - `getScannerStatus()`
  - `scanAndIndex()`
  - `registerFileSearchProject(...)`
  - `listFileSearchProjects(...)`
  - `unregisterFileSearchProject(...)`
- Sprint 36 made file-search DB storage global by default.
- Sprint 37 added global registry table/operations and CLI registry commands, including `openFileSearchRegistryDb()` to avoid scheduler side effects for registry-only operations.
- The extension currently opens its memory `nativeStore` at the global runtime base dir, but active project identity is derived separately from cwd. File-search tools must not accidentally search/scan the global runtime directory.
- Direct file-search tools should not reuse the module-level memory `nativeStore` as their project-scoped file-search store, because that store's `baseDir` is the global runtime directory. They need a target-project-aware helper that uses global storage while scoping file-search identity to the active/explicit project.

## Recommended Tool Contract
Prefer separate, single-purpose tools. This mirrors existing BYOMem tool style and keeps side effects obvious.

### `byomem_file_search`
Purpose: search indexed project files.

Parameters:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "mode": { "type": "string", "enum": ["fts", "semantic", "hybrid"] },
    "limit": { "type": "integer", "minimum": 1 },
    "baseDir": { "type": "string" }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

Semantics:
- Defaults to the active project when `baseDir` is omitted.
- Uses explicit `baseDir` when provided.
- Searches the current file-search index only; it must not implicitly scan project files.
- Defaults `mode` to `hybrid` or the existing runtime default.
- Must not call `refreshSemanticIndex()` implicitly for semantic/hybrid modes; semantic/hybrid search may use already-ready embeddings but must not perform hidden embedding refresh work.
- Rejects blank `query`, invalid `mode`, and invalid/non-integer/less-than-1 `limit` with deterministic errors.
- Returns compact file hit DTOs with this stable shape:
  ```json
  {
    "results": [
      {
        "id": "string",
        "score": 0,
        "file": {
          "project_key": "string",
          "path": "string",
          "chunk_index": 0,
          "chunk_text": "string",
          "chunk_hash": "string",
          "lexical_score": 0,
          "semantic_score": 0
        }
      }
    ]
  }
  ```
  Optional score fields may be omitted when undefined, but field names must be snake_case in direct tool JSON.

### `byomem_file_search_status`
Purpose: inspect scanner status for a project.

Parameters:
```json
{
  "type": "object",
  "properties": {
    "baseDir": { "type": "string" }
  },
  "additionalProperties": false
}
```

Semantics:
- Defaults to active project when `baseDir` is omitted.
- Uses explicit `baseDir` when provided.
- Opens file-search with scan-on-open disabled.
- Must not scan, schedule polling, start watchers, refresh embeddings, or create project-local memory stores. Sprint 39 preserves this behavior; polling status/enable/disable use separate tool names.
- Returns scanner/status DTO consistent with CLI `file-search-status`, using this top-level shape:
  ```json
  {
    "scanner": { "state": "idle", "projectKey": "...", "baseDir": "...", "progress": {}, "database": {} },
    "status": { "state": "idle", "projectKey": "...", "baseDir": "...", "progress": {}, "database": {} }
  }
  ```
  Scanner/status objects intentionally retain the existing runtime/CLI camelCase field names. File-hit and registry DTOs use snake_case only where already specified.

### `byomem_file_search_scan`
Purpose: explicitly trigger a scanner run for a project.

Parameters:
```json
{
  "type": "object",
  "properties": {
    "baseDir": { "type": "string" }
  },
  "additionalProperties": false
}
```

Semantics:
- Defaults to active project when `baseDir` is omitted.
- Uses explicit `baseDir` when provided.
- Runs exactly one synchronous manual scan (`trigger: manual`).
- Intended for agents after they know they changed files and want the index updated sooner.
- Must not start polling, watchers, daemons, or background scans.
- Returns resulting scanner/status DTO with the same top-level `{ "scanner": ..., "status": ... }` shape as the status tool.

### Registry tools
Use separate tools:

#### `byomem_file_search_project_register`
```json
{
  "type": "object",
  "properties": {
    "baseDir": { "type": "string" }
  },
  "required": ["baseDir"],
  "additionalProperties": false
}
```

#### `byomem_file_search_project_list`
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `byomem_file_search_project_unregister`
```json
{
  "type": "object",
  "properties": {
    "baseDir": { "type": "string" }
  },
  "required": ["baseDir"],
  "additionalProperties": false
}
```

Semantics:
- Register/unregister require explicit `baseDir`; they must not default to the active project because registry enablement is explicit opt-in.
- List does not require `baseDir`.
- Registry tools use the registry-only DB open path and must not instantiate scanner/scheduler timers.
- Preserve `seen`/`enabled`/`disabled` semantics and soft-disable unregister.

## Active Project / `baseDir` Semantics
- `baseDir` is the target project root, not DB storage location.
- If a search/status/scan tool omits `baseDir`, it targets the active project from `resolveActiveProjectContext()` / cwd context.
- If no active project can be resolved or the active project is ambiguous, search/status/scan must fail with a deterministic error such as `Unable to resolve active project for file-search tool; provide baseDir`.
- If `baseDir` is supplied, the tool targets `resolve(baseDir)`.
- `BYOMEM_RUNTIME_BASE_DIR` only controls global BYOMem/file-search storage; it must not redefine the project being searched/scanned.
- Registry register/unregister require explicit `baseDir` even if active project is known, because automatic enablement is intentionally avoided.

## Side-Effect Policy
- `byomem_file_search`: no implicit scan, no implicit project registration, no hidden polling, no implicit semantic embedding refresh. It may update a `seen` registry row with source `manual-search` if that matches Sprint 37 runtime behavior, but must never set `enabled`.
- `byomem_file_search_status`: no scan, no hidden polling. It may update a `seen` registry row with source `manual-status`, but must never set `enabled`.
- `byomem_file_search_scan`: exactly one explicit synchronous scan; no hidden polling after completion. It may update a `seen` registry row with source `manual-scan`, but must never set `enabled`.
- Registry tools: no scan, no hidden polling, no memory store writes. They must use `openFileSearchRegistryDb()` or an equivalent scheduler-free global registry DB open path.
- Memory tools: no file-search registry creation or enablement.

Implementation must add a file-search runtime open option such as `schedulerEnabled: false` or an equivalent direct-tool helper so search/status/scan tools avoid unnecessary `FileIndexScheduler` timer construction while preserving existing scheduler behavior for code paths that need it. The implementation must not use the extension's module-level memory `nativeStore` for target project file-search operations unless it explicitly supplies the target as `fileSearchProjectBaseDir` and disables scan-on-open/scheduler side effects.

## Acceptance Criteria
- [ ] **AC38-1:** Pi extension registers the six direct file-search tools alongside existing BYOMem tools.
- [ ] **AC38-2:** Tool schemas are strict, documented, and tested, including required `query` and registry `baseDir` fields.
- [ ] **AC38-3:** `byomem_file_search` uses active project by default, explicit `baseDir` when supplied, never treats global runtime storage as the project root, and fails deterministically when neither active project nor explicit `baseDir` is available.
- [ ] **AC38-4:** `byomem_file_search` searches indexed files without implicitly scanning project files or refreshing semantic embeddings.
- [ ] **AC38-5:** `byomem_file_search_status` returns scanner status without scanning, using the global DB with target project identity and without scheduling background work.
- [ ] **AC38-6:** `byomem_file_search_scan` performs exactly one explicit manual scan for the target project and returns updated scanner/status data.
- [ ] **AC38-7:** Direct file-search tools do not create project-local `native-store.json`, `byomem-index.sqlite`, or `byomem-file-search.sqlite` files by default.
- [ ] **AC38-8:** Registry tools preserve Sprint 37 semantics: explicit register, soft-disable unregister, all-state list sorted by `base_dir ASC`, and no inference from memories/search/scan usage.
- [ ] **AC38-9:** Registry register/unregister reject missing or blank `baseDir`; project list does not require `baseDir`; registry tools use the scheduler-free registry DB open path.
- [ ] **AC38-10:** Existing memory tools continue to behave as before and do not create/enable file-search registry rows.
- [ ] **AC38-11:** Docs and the global file-search project registration skill prefer direct tools and document CLI fallback.
- [ ] **AC38-12:** The globally installed BYOMem extension path is verified to expose the new direct tools after a fresh Pi session/reload or equivalent extension wiring check.
- [ ] **AC38-13:** Full test suite and build pass.

## Execution Mode
standard

Rationale: most implementation converges on `pi-extension.ts` plus file-search runtime open semantics. Tests and docs can be parallelized after the core tool contract is locked, but the shared extension file should be edited serially.

## Phase 0 — RED Tests / Contract Locking
- [ ] **0.1** Add extension registration/schema RED tests.
  - Role: test-engineer
  - Files: `ts/packages/runtime/tests/byomem-extension-wiring.test.ts` or new `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`.
  - Deliverable: failing tests proving the six tool names are registered and schemas match contract.
  - Verify: `npm test -- --run ts/packages/runtime/tests/byomem-extension-wiring.test.ts` fails before implementation.

- [ ] **0.2** Add active-project vs runtime-storage RED tests.
  - Role: test-engineer
  - Deliverable: failing tests proving omitted `baseDir` uses active project/cwd, `BYOMEM_RUNTIME_BASE_DIR` affects storage only, and missing/ambiguous active project fails with a deterministic error instead of falling back to runtime storage.
  - Verify: targeted Sprint 38 tests fail before implementation.

- [ ] **0.3** Add `byomem_file_search` behavior RED tests.
  - Role: test-engineer
  - Deliverable: failing tests for required/blank query, invalid mode rejection, positive integer limit validation, explicit `baseDir` scoping, same-basename project isolation, no implicit scan, no implicit semantic refresh, and compact snake_case DTO output.
  - Verify: targeted tests fail before implementation.

- [ ] **0.4** Add scanner status RED tests.
  - Role: test-engineer
  - Deliverable: failing tests proving status returns scanner data, opens with scan disabled, and does not index files or instantiate scheduler timers.
  - Verify: targeted tests fail before implementation.

- [ ] **0.5** Add explicit scanner trigger RED tests.
  - Role: test-engineer
  - Deliverable: failing tests proving scan triggers one manual scan, returns completed status, updates index rows, and does not leave polling/watcher side effects.
  - Verify: targeted tests fail before implementation.

- [ ] **0.6** Add registry tool RED tests.
  - Role: test-engineer
  - Deliverable: failing tests for register/list/unregister tools, missing and blank `baseDir` rejection, all-state sorted output, soft-disable unregister, no scan/memory side effects, and no scheduler timer construction through the registry tool path.
  - Verify: targeted tests fail before implementation.

- [ ] **0.7** Add no-memory-inference regression tests if not already covered through Sprint 37.
  - Role: test-engineer
  - Deliverable: tests proving memory tools still do not create/enable file-search registry rows.
  - Verify: targeted tests pass after implementation.

## Phase 1 — Runtime Helper / Tool Infrastructure
- [ ] **1.1** Add project target resolver for file-search tools.
  - Role: typescript-coder
  - Files: `ts/packages/runtime/src/pi-extension.ts` or small helper module.
  - Deliverable: normalizes optional `baseDir`, resolves active project default, fails deterministically when no project is available, and separates target project root from runtime storage.
  - Depends on: 0.2
  - Verify: active-project tests pass.

- [ ] **1.2** Add direct-tool file-search open/query helper with no hidden scheduler behavior.
  - Role: typescript-coder
  - Files: `file-search-db.ts`, `file-search-query.ts`, `store.ts`, or extension helper as needed.
  - Deliverable: search/status/scan tools can open/query file-search for a target project with scan-on-open disabled, global DB storage, target project identity, no project-local memory stores, and no scheduler timer unless a code path explicitly requires it.
  - Depends on: 0.4, 0.5
  - Verify: status/scan/search no-polling and no-runtime-directory-target tests pass.

- [ ] **1.3** Add result DTO serializers.
  - Role: typescript-coder
  - Files: `pi-extension.ts` or helper module.
  - Deliverable: compact JSON results for file hits, scanner status, registry entries.
  - Depends on: 0.3-0.6
  - Verify: DTO tests pass.

## Phase 2 — Tool Implementations
- [ ] **2.1** Implement `byomem_file_search`.
  - Role: typescript-coder
  - Deliverable: direct file-search query tool using target project root and global DB storage, with strict validation and no implicit scan.
  - Depends on: Phase 1
  - Verify: `byomem_file_search` tests pass.

- [ ] **2.2** Implement `byomem_file_search_status`.
  - Role: typescript-coder
  - Deliverable: status-only tool returning scanner/status DTO without scanning.
  - Depends on: Phase 1
  - Verify: status tests pass.

- [ ] **2.3** Implement `byomem_file_search_scan`.
  - Role: typescript-coder
  - Deliverable: explicit manual scan tool returning updated scanner/status DTO.
  - Depends on: Phase 1
  - Verify: scan tests pass.

- [ ] **2.4** Implement registry direct tools.
  - Role: typescript-coder
  - Deliverable: direct register/list/unregister tools using `openFileSearchRegistryDb()` and Sprint 37 registry serializers.
  - Depends on: Phase 1
  - Verify: registry tool tests pass.

## Phase 3 — Docs / Global Skill Updates
- [x] **3.1** Update file-search runbook.
  - Role: documenter
  - Files: `docs/semantic-hybrid-document-search-runbook.md`.
  - Deliverable: direct tool usage guidance, active-project/default `baseDir` semantics, CLI fallback, scan/status workflow, and explicit no-watchers/no-polling guidance.
  - Depends on: Phase 2
  - Verify: docs review.

- [x] **3.2** Update global skill `~/.pi/agent/skills/file-search-project-registration/SKILL.md`.
  - Role: documenter
  - Deliverable: skill prefers direct tools when available, with CLI fallback and exact tool names.
  - Depends on: Phase 2
  - Verify: skill file frontmatter remains valid; record a checklist in this sprint doc or runbook showing the exact global path, frontmatter, direct tool names, fallback CLI commands, and fresh-session/reload verification that the tools appear in Pi's available tool list.

- [ ] **3.3** Add docs index/roadmap links.
  - Role: documenter
  - Files: `docs/README.md`, `docs/pi-memory-roadmap.md`, this sprint doc.
  - Depends on: none
  - Verify: links resolve.

## Phase 4 — Regression / Review
- [ ] **4.1** Run focused Sprint 38 tests.
  - Role: test-engineer
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

- [ ] **4.2** Run file-search regression slice.
  - Role: test-engineer
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
      ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts \
      ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts
    ```

- [ ] **4.3** Run full validation.
  - Role: test-engineer
  - Verify:
    ```bash
    npm test -- --run
    npm run build
    git diff --check
    ```

- [ ] **4.4** Independent code review.
  - Role: code-reviewer
  - Deliverable: review tool schemas, active-project semantics, side-effect boundaries, registry safety, and docs/skill accuracy.

## Risks & Mitigations
- **Risk: tools accidentally search/scan the global runtime directory.**
  - Mitigation: explicit target project resolver and tests proving `BYOMEM_RUNTIME_BASE_DIR` is storage-only.

- **Risk: hidden scan/polling side effects.**
  - Mitigation: search/status open with scan disabled; add tests for no index mutation and no scheduler timer side effects.

- **Risk: too many tools clutter tool list.**
  - Mitigation: names are explicit and side-effect obvious; registry split mirrors memory tool clarity.

- **Risk: scan tool is overused after every small edit.**
  - Mitigation: docs/skill instruct agents to use it when they knowingly changed files and need search freshness, not automatically after every turn.

- **Risk: direct tools drift from CLI behavior.**
  - Mitigation: reuse runtime functions, share serializers where practical, and keep CLI as fallback/debug surface.

- **Risk: global skill update is outside repo tracking.**
  - Mitigation: document exact global skill path and include a verification checklist in the sprint closeout.

## Definition of Done
- [x] Sprint 38 doc linked from docs index and roadmap.
- [x] Six direct file-search tools registered in Pi extension.
- [x] Tool schemas and behavior covered by RED/GREEN tests.
- [x] Active-project/default `baseDir` semantics are documented and tested.
- [x] Search/status tools do not scan implicitly.
- [x] Scan tool performs one explicit manual scan.
- [x] Registry tools preserve Sprint 37 explicit opt-in semantics.
- [x] No hidden polling/watcher/background scanner side effects.
- [x] Global skill updated to prefer direct tools with CLI fallback.
- [x] Fresh-session/reload verification confirms the globally installed BYOMem extension exposes the direct file-search tools.
- [ ] Focused tests, file-search regression, full suite, build, and `git diff --check` pass.
- [ ] Independent review signs off.
