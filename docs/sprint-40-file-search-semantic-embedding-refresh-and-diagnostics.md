# Sprint 40 — File Search Semantic Embedding Refresh and Diagnostics

## Objective
Make BYOMem file-search semantic behavior safe and predictable by enforcing project-scoped diagnostics, explicit project-scoped embedding refresh, resolved Pi embedding config propagation, and dimension-safe semantic querying. Eliminate stale or incompatible vector use without adding hidden embedding work to `status`, `scan`, or broad semantic query execution.

## Scope
**In scope**
- Project-scoped diagnostics and refresh behavior in `ts/packages/runtime/src/file-search-db.ts`.
- Semantic query dimension compatibility checks in `ts/packages/runtime/src/file-search-query.ts`.
- Resolved embedding config propagation through `ts/packages/runtime/src/pi-extension.ts` and `ts/packages/runtime/src/store.ts`.
- Explicit project-scoped refresh surface in `ts/packages/runtime/src/cli.ts` and `ts/packages/runtime/src/pi-extension.ts`.
- Cache/vector invalidation safety in `ts/packages/runtime/src/embedding-client.ts` and `ts/packages/runtime/src/embedding-vector.ts`.
- RED/green regression coverage in:
  - `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`
  - `ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts`
  - `ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`
  - `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`
  - `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`
  - `ts/packages/runtime/tests/byomem-extension-wiring.test.ts`
  - `ts/packages/runtime/tests/cli.test.ts`

**Out of scope**
- Scheduler, polling, watcher, or background refresh changes.
- Any non-project-scoped/global refresh or diagnostics behavior.
- Unrelated embedding-provider UX or provider-selection redesign.
- Hidden embedding work in `status` or `scan`.
- Broad automatic on-query refresh for semantic/hybrid search; if reconsidered later, treat as deferred follow-up, not Sprint 40.

## Investigation Summary
- `embeddingDiagnostics()` currently aggregates across all projects; Sprint 40 must return project-scoped diagnostics only.
- `refreshSemanticIndex()` currently refreshes globally; Sprint 40 must refresh only the requested project.
- Pi `openDirectFileSearchDb()` does not consistently receive resolved embedding config, allowing semantic drift from configured provider/model/dimension.
- `byomem_file_search` semantic/hybrid currently lacks a safe explicit refresh contract. Sprint 40 will use an explicit project-scoped refresh command/tool as the primary contract.
- `querySemantic()` filters by project/model but not configured vs actual dimensions; stale `3`/`1536` vectors must never rank under current `768` configuration.
- Cache/vector reuse may return stale fallback/mock vectors after provider/model/dimension changes.
- Same-basename projects must remain isolated by true project identity, not basename collisions.

## Acceptance Criteria
1. **Given** two indexed BYOMem projects, **when** diagnostics are requested for one project, **then** diagnostics are strictly project-scoped and expose exactly the Sprint 40 diagnostics fields: `enabled`, `state`, `projectKey`, `baseDir`, `model`, `configuredDimension`, `actualDimensions`, `indexedChunks`, `embeddedChunks`, `missingChunks`, `incompatibleChunks`, `refreshNeededChunks`, `failedChunks`, `failures`, `fallbacks`, and optional `lastError`.
2. **Given** project-scoped diagnostics are reported, **when** the project has mixed semantic states, **then** `state` is one of `disabled`, `ready`, `refresh-needed`, or `incompatible`; `failures === failedChunks`; `refreshNeededChunks = missingChunks + incompatibleChunks + failedChunks`; and `actualDimensions` is sorted ascending as `{ dimension, chunks }`.
3. **Given** two projects share similar or identical basenames, **when** diagnostics or semantic refresh run for one project, **then** only the targeted project’s rows/files are inspected or refreshed by true project identity, not basename.
4. **Given** a project has missing or stale embeddings, **when** `status` or `scan` is executed, **then** BYOMem reports refresh-needed state without generating embeddings or refreshing semantic rows.
5. **Given** a project has missing or incompatible embeddings, **when** semantic/hybrid search is executed through Pi or CLI surfaces, **then** BYOMem performs no hidden refresh, uses only compatible ready embeddings, and returns semantic refresh-needed/incompatible metadata.
6. **Given** a user invokes CLI command `file-search-semantic-refresh --base-dir <projectDir>` or Pi tool `byomem_file_search_semantic_refresh`, **when** refresh completes, **then** exactly one project-scoped semantic refresh runs, no scan/search runs, only the targeted project’s semantic rows are updated, and diagnostics reflect the new state.
7. **Given** active embedding configuration includes a configured dimension such as `768`, **when** stored semantic rows contain stale `3`, `1536`, wrong-provider, wrong-model, wrong-configured-dimension, stale-hash, non-ready, or legacy-provider rows, **then** semantic/hybrid ranking excludes those rows.
8. **Given** Pi opens direct file-search DB/query paths, **when** semantic search or refresh runs, **then** resolved Pi embedding config from runtime/store is passed through consistently, including `embeddingDimension`.
9. **Given** provider/model/dimension config changes, **when** a new embedding/vector is requested, **then** cache identity includes provider key, model, configured dimension, effective dimension, text hash, and version `file-search-embedding-v1`, so stale cached fallback/mock/remote vectors are not reused across the config boundary.
10. **Given** Sprint 40 changes are complete, **when** focused tests and build run, **then** all listed Sprint 40 suites pass and `npm run build` succeeds.

## Execution Mode
**Serialized shared-kernel first, then limited parallelization.**

All `ts/packages/runtime/src/file-search-db.ts` diagnostics/refresh/status-contract work must land first because it is the shared kernel and highest conflict surface. After that, query/cache hardening and CLI/extension wiring may proceed in parallel, followed by final integration and review.

## Refresh Contract
**Primary contract for Sprint 40:** explicit project-scoped refresh command/tool.

### CLI command: `file-search-semantic-refresh`
- Requires `--base-dir <projectDir>`.
- Supports `--limit <positive integer>`.
- Supports embedding overrides: `--embedding-base-url`, `--embedding-model`, `--embedding-dimension`, and `--embedding-timeout-ms`.
- Opens file-search with `scanOnOpen: false`.
- Does not scan.
- Does not search.
- Calls exactly one project-scoped semantic refresh.
- JSON output includes:
  - `refresh.command`
  - `refresh.baseDir`
  - `refresh.projectKey`
  - `refresh.limit`
  - `diagnostics`
  - `embeddings`

### Pi tool: `byomem_file_search_semantic_refresh`
- Input schema is `{ baseDir?: string, limit?: positive integer }` with `additionalProperties: false`.
- Omitted `baseDir` resolves the active project like existing direct file-search tools.
- Blank `baseDir` rejects.
- Uses resolved Pi embedding config.
- Does not scan.
- Does not search.
- Does not poll.
- Calls exactly one project-scoped semantic refresh.
- Output includes content text plus top-level `details`, `refresh`, `diagnostics`, and `embeddings`.
- `refresh.tool` equals `byomem_file_search_semantic_refresh`.

### Hidden-work boundary
- `status` never refreshes embeddings.
- `scan` never refreshes embeddings.
- CLI and Pi semantic/hybrid search never perform hidden semantic refresh.
- Semantic/hybrid search may embed the query only when needed to rank compatible ready rows, use ready embeddings only, and report refresh-needed/incompatible state when embeddings are missing/stale.
- Bounded on-query refresh is **out of scope/deferred** for this sprint.

## Diagnostics Contract
Project-scoped diagnostics must expose exactly these fields, plus optional `lastError` when available:
- `enabled`
- `state`
- `projectKey`
- `baseDir`
- `model`
- `configuredDimension`
- `actualDimensions`
- `indexedChunks`
- `embeddedChunks`
- `missingChunks`
- `incompatibleChunks`
- `refreshNeededChunks`
- `failedChunks`
- `failures`
- `fallbacks`
- `lastError` when available

Diagnostics rules:
- `state` is `disabled`, `ready`, `refresh-needed`, or `incompatible`.
- Counts are project-scoped.
- `failures === failedChunks`.
- `refreshNeededChunks = missingChunks + incompatibleChunks + failedChunks`.
- `actualDimensions` is sorted ascending as `{ dimension, chunks }`.

## Search Response Semantic Metadata Contract
Semantic and hybrid CLI/Pi search responses must include a `semantic` metadata object with:
- `requested`
- `enabled`
- `used`
- `state`
- `refreshNeeded`
- `incompatible`
- `projectKey`
- `model`
- `configuredDimension`
- `actualDimensions`
- optional `queryDimension`
- optional `queryDimensionCompatible`
- `embeddedChunks`
- `missingChunks`
- `incompatibleChunks`
- `refreshNeededChunks`
- `failedChunks`
- `failures`
- `refreshCommand` equal to `file-search-semantic-refresh`
- `refreshTool` equal to `byomem_file_search_semantic_refresh`

Semantic and hybrid ranking may use only rows that satisfy all of these compatibility requirements:
- same project,
- current chunk hash,
- active provider,
- active model,
- active configured dimension,
- status `ready`,
- actual row dimension equals query vector length,
- row is compatible with current configured dimension.

## Embedding Dimension Config Contract
- YAML config key: `embeddings.dimension`.
- Env var: `BYOMEM_EMBEDDING_DIMENSION`.
- CLI flag: `--embedding-dimension`.
- TypeScript/runtime option: `embeddingDimension`.
- Pi runtime status field: `embeddingDimension`.
- Precedence is env > YAML > undefined.
- Invalid CLI value fails with exact error: `--embedding-dimension must be a positive integer`.

## Embedding Cache Identity Contract
Embedding cache identity must include:
- version `file-search-embedding-v1`,
- provider key,
- model,
- configured dimension,
- effective dimension,
- text hash.

Provider key rules:
- Remote provider key is `remote:${new URL('/api/embeddings', embeddingBaseUrl).toString()}`.
- Fallback provider key is `fallback:deterministic-v1`.
- Legacy rows without provider identity are incompatible/refresh-needed.

## RED Test Strategy
1. Add a focused Sprint 40 RED suite in `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts` covering:
   - exact project-scoped diagnostics fields, state, counts, `actualDimensions`, `failures`, and `refreshNeededChunks`
   - same-basename project isolation for diagnostics and refresh
   - semantic/hybrid CLI search no-hidden-refresh behavior plus `semantic` refresh-needed metadata
   - explicit CLI `file-search-semantic-refresh` existence, validation, JSON shape, and project-scoped refresh behavior
   - Pi `embeddingDimension` config precedence/status propagation and direct file-search semantic metadata
   - Pi `byomem_file_search_semantic_refresh` schema, baseDir/limit validation, and output contract
   - compatible-ready-only semantic query behavior for provider/model/configured-dimension/effective-dimension/current-hash/status boundaries
   - embedding cache invalidation across provider/model/configured-dimension/effective-dimension identity
2. Keep any later companion edits to existing Sprint 32/33/38/CLI suites scoped to acceptance criteria only; Phase 0 starts with the new Sprint 40 RED suite so missing implementation failures are explicit and easy to triage.

## Workstreams
- **WS-A — Shared DB kernel:** `ts/packages/runtime/src/file-search-db.ts` and scanner/status diagnostics tests. This work is serialized first.
- **WS-B — Query/cache safety:** `ts/packages/runtime/src/file-search-query.ts`, `ts/packages/runtime/src/embedding-client.ts`, and `ts/packages/runtime/src/embedding-vector.ts` after WS-A.
- **WS-C — CLI/Pi surfaces:** `ts/packages/runtime/src/cli.ts`, `ts/packages/runtime/src/pi-extension.ts`, and `ts/packages/runtime/src/store.ts` after WS-A.

## Phases & Tasks

### Phase 0 — RED baseline
- [x] **0.1** Add RED tests for project-scoped diagnostics shape and same-basename isolation
  - Role: test-engineer
  - Deliverable: failing cases in `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts` for project-only counts, required diagnostics fields, and basename collision isolation.
  - Depends on: none
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`

- [x] **0.2** Add RED tests for no hidden refresh in `status`/`scan` and explicit refresh contract
  - Role: test-engineer
  - Deliverable: failing cases in `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`, `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`, and `ts/packages/runtime/tests/cli.test.ts`.
  - Depends on: none
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/cli.test.ts`

- [x] **0.3** Add RED tests for dimension filtering, stale cache invalidation, and Pi config propagation
  - Role: test-engineer
  - Deliverable: failing cases in `ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`, `ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts`, and `ts/packages/runtime/tests/byomem-extension-wiring.test.ts`.
  - Depends on: none
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts`

### Phase 1 — Shared-kernel DB work (serialize before parallelization)
- [x] **1.1** Scope diagnostics to one project in `ts/packages/runtime/src/file-search-db.ts`
  - Role: typescript-coder
  - Deliverable: `embeddingDiagnostics()` returns only targeted project counts/fields: `embeddedChunks`, `missingChunks`, `incompatibleChunks`, `failedChunks` or `failures`, `configuredDimension`, `actualDimensions` or equivalent summary, and `lastError` when available.
  - Depends on: 0.1
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`

- [x] **1.2** Enforce same-project targeting for refresh in `ts/packages/runtime/src/file-search-db.ts`
  - Role: typescript-coder
  - Deliverable: `refreshSemanticIndex()` updates only rows/files for the requested project identity, including same-basename isolation.
  - Depends on: 1.1
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`

- [x] **1.3** Preserve read-only `status`/`scan` semantics in `ts/packages/runtime/src/file-search-db.ts` and dependent call paths
  - Role: typescript-coder
  - Deliverable: status-facing diagnostics/reporting that detects refresh-needed state without generating embeddings or triggering semantic refresh.
  - Depends on: 1.1, 1.2
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/cli.test.ts`

### Phase 2 — Parallel work after DB kernel lands

#### Workstream B — Query and cache hardening
- [x] **2.1** Filter incompatible dimensions in `ts/packages/runtime/src/file-search-query.ts`
  - Role: typescript-coder
  - Deliverable: semantic ranking uses only rows matching the active configured dimension and actual query vector dimension; stale `3`/`1536` rows are excluded under `768`.
  - Depends on: 1.3, 0.3
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`

- [x] **2.2** Fix cache/vector invalidation in `ts/packages/runtime/src/embedding-client.ts` and `ts/packages/runtime/src/embedding-vector.ts`
  - Role: typescript-coder
  - Deliverable: cache keys and fallback/mock reuse vary by provider/model/dimension so stale vectors cannot leak across config changes.
  - Depends on: 1.3, 0.3
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts`

#### Workstream C — CLI and Pi extension wiring
- [x] **2.3** Propagate resolved embedding config through `ts/packages/runtime/src/store.ts` and `ts/packages/runtime/src/pi-extension.ts`
  - Role: typescript-coder
  - Deliverable: Pi direct file-search DB/query execution receives resolved provider/model/dimension config from BYOMem runtime state.
  - Depends on: 1.3, 0.3
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/byomem-extension-wiring.test.ts`

- [x] **2.4** Add explicit project-scoped refresh surface in `ts/packages/runtime/src/cli.ts` and `ts/packages/runtime/src/pi-extension.ts`
  - Role: typescript-coder
  - Deliverable: CLI and Pi tool/command that refresh only the targeted project’s semantic embeddings and report updated diagnostics; no hidden refresh added to semantic/hybrid search.
  - Depends on: 1.3, 0.2, 2.3
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/cli.test.ts`

### Phase 3 — Integration and validation
- [x] **3.1** Integrate semantic query behavior with explicit refresh-needed reporting
  - Role: builder
  - Deliverable: semantic/hybrid search surfaces use ready embeddings only, report refresh-needed/incompatible state clearly, and honor project-scoped diagnostics.
  - Depends on: 2.1, 2.2, 2.3, 2.4
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/cli.test.ts`

- [x] **3.2** Run focused Sprint 40 verification and build
  - Role: test-engineer
  - Deliverable: passing focused Sprint 40 test evidence and successful TypeScript build.
  - Depends on: 3.1
  - Verify: `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/cli.test.ts && npm run build`

- [x] **3.3** Independent review of scope boundaries and hidden-work guarantees
  - Role: code-reviewer
  - Deliverable: sign-off that Sprint 40 preserved out-of-scope boundaries, especially no scheduler/polling changes, no non-project refresh, and no hidden work in `status`/`scan`.
  - Depends on: 3.2
  - Verify: review confirms Acceptance Criteria 1-10 and Out of scope boundaries.

## Risks & Mitigations
- **Risk:** Existing DB helpers may still assume global aggregation or weak project identity.
  - **Mitigation:** write RED tests first for multi-project and same-basename isolation in `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`.
- **Risk:** CLI and Pi may diverge in embedding config resolution.
  - **Mitigation:** route both through `ts/packages/runtime/src/store.ts` resolution and verify with `ts/packages/runtime/tests/byomem-extension-wiring.test.ts` and `ts/packages/runtime/tests/cli.test.ts`.
- **Risk:** Query filtering may still allow stale cached vectors after config changes.
  - **Mitigation:** combine query-dimension filtering with cache key invalidation in `ts/packages/runtime/src/embedding-client.ts` and `ts/packages/runtime/src/embedding-vector.ts`.
- **Risk:** User expectations may assume semantic search auto-refreshes.
  - **Mitigation:** keep explicit refresh as the Sprint 40 contract and ensure diagnostics/search responses clearly indicate refresh-needed state and available refresh command/tool.
- **Risk:** Expanding diagnostics fields could destabilize existing consumers.
  - **Mitigation:** reuse existing field names where possible and extend tests on CLI/extension surfaces before implementation.

## Definition of Done
- Sprint artifact is implementation-ready for `docs/sprint-40-file-search-semantic-embedding-refresh-and-diagnostics.md`.
- RED tests are added first for:
  - project-scoped diagnostics shape
  - same-basename project isolation
  - no hidden refresh from `status`/`scan`
  - explicit project refresh contract
  - dimension filtering
  - stale cache invalidation
  - Pi config propagation
- `ts/packages/runtime/src/file-search-db.ts` provides project-scoped diagnostics and explicit project-scoped refresh only.
- `ts/packages/runtime/src/file-search-query.ts` excludes incompatible semantic rows by configured/actual dimension compatibility.
- `ts/packages/runtime/src/pi-extension.ts` and `ts/packages/runtime/src/store.ts` propagate resolved embedding config into Pi direct file-search behavior.
- `ts/packages/runtime/src/cli.ts` and `ts/packages/runtime/src/pi-extension.ts` expose explicit project-scoped refresh without adding hidden refresh to `status`, `scan`, or broad semantic query execution.
- `ts/packages/runtime/src/embedding-client.ts` and `ts/packages/runtime/src/embedding-vector.ts` do not reuse stale fallback/mock vectors across provider/model/dimension changes.
- Out-of-scope boundaries remain intact: no scheduler/polling changes, no non-project-scoped refresh, no unrelated provider UX changes, no hidden work in `status`/`scan`, no on-query auto-refresh.
- Verification passes:
  - `cd /Users/ericsmith/Documents/byomem && npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/cli.test.ts`
  - `cd /Users/ericsmith/Documents/byomem && npm run build`

## Implementation Closeout
- Completed Sprint 40 implementation for project-scoped semantic diagnostics and explicit project-scoped refresh.
- Added/updated focused RED/green coverage for diagnostics shape, same-basename isolation, no hidden refresh, CLI/Pi explicit refresh, dimension/config propagation, compatible-ready-only query filtering, unversioned row exclusion, and cache identity boundaries.
- Independent review identified semantic fallback/versioning/config-validation gaps; fixes were applied and re-verified.
- Final verification passed: targeted Sprint 40/regression suite (70 tests), full suite (47 files / 242 tests), `npm run build`, and `git diff --check`.
