# Sprint 40 Code Review — Final Review After H1/M1/M2/M3 Fixes

## 1) Summary verdict

**Final verdict: Ready for Sprint 40 completion from code-review perspective.**

The latest working tree resolves the previously identified blocking findings H1, M1, M2, and M3. I found **no remaining blocking correctness, TypeScript/build, project-scoping, hidden-work, or Sprint 40 acceptance-criteria issues** in the requested review scope.

Verification performed during final review:

```bash
npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
npm run build
npm test -- \
  ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts \
  ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts \
  ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
  ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts \
  ts/packages/runtime/tests/byomem-extension-wiring.test.ts \
  ts/packages/runtime/tests/cli.test.ts \
  ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
```

Results:

- Focused Sprint 40 suite: **passed** — 10 tests.
- Build: **passed**.
- Broader listed Sprint 40-related suite: **passed** — 7 files, 70 tests.

## 2) Findings by severity

### Blockers

**None remaining.**

### Previously identified findings — resolved

#### H1 — Pure `semantic` search fell back to lexical/FTS results

- **Status:** Resolved.
- **File:** `ts/packages/runtime/src/file-search-query.ts`
- **Lines:** 220-223

The implementation now returns only compatible semantic rows for pure semantic mode:

```ts
const semanticRows = await querySemantic(store, projectKey, query.query, mode === 'hybrid' ? limit * 2 : limit);
const safeSemanticRows = semanticRows.filter(isSafeFileSearchRow);
if (mode === 'semantic') return safeSemanticRows.slice(0, limit).map(buildHit);
```

This restores semantic-only behavior while preserving hybrid FTS fallback at line 223.

#### M1 — Semantic metadata performed a second query embedding call

- **Status:** Resolved.
- **File:** `ts/packages/runtime/src/file-search-query.ts`
- **Lines:** 179-205

`buildSearchSemanticMetadata()` now reads diagnostics and derives `used` from hits without embedding the query again:

```ts
const diagnostics = fileDb.getEmbeddingDiagnostics();
const used = Boolean(hits?.some((hit) => hit.file?.semanticScore !== undefined));
```

The optional `queryDimension` / `queryDimensionCompatible` fields remain in the TypeScript interface but are not populated by this metadata path, which is acceptable because they are optional in the Sprint 40 metadata contract.

#### M2 — Unversioned embedding rows were eligible for semantic ranking

- **Status:** Resolved.
- **File:** `ts/packages/runtime/src/file-search-query.ts`
- **Line:** 87

Semantic ranking now requires the Sprint 40 identity version exactly:

```ts
AND e.identity_version = ?
```

The focused Sprint 40 test now includes a legacy unversioned row and verifies it is excluded from semantic results.

Relevant test references:

- `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts:485`
- `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts:502-507`

#### M3 — Pi/env embedding dimension was not validated

- **Status:** Resolved.
- **File:** `ts/packages/runtime/src/pi-extension.ts`
- **Lines:** 397-420

Pi config resolution now validates env/YAML embedding dimensions as positive safe integers:

```ts
function parsePositiveSafeIntegerConfig(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
```

Regression coverage exists for invalid YAML and invalid env values:

- `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts:435-447`

### Non-blocking notes

#### N1 — Existing cache lookup index shape is not force-migrated

- **Severity:** Low / non-blocking.
- **File:** `ts/packages/runtime/src/file-search-db.ts`
- **Line:** 418

The implementation creates the new composite lookup index with `CREATE INDEX IF NOT EXISTS`. If an older database already has `idx_file_embedding_cache_lookup` with the old three-column shape, SQLite will keep the existing index.

This does **not** appear to be a correctness blocker because current cache lookups use the primary cache `id`, which includes provider/model/configured dimension/effective dimension/text hash/version. Treat this as a possible future performance/schema hygiene improvement, not a Sprint 40 blocker.

#### N2 — Untracked `.gemini/` remains in the working tree

- **Severity:** Low / non-blocking.
- **Path:** `.gemini/`

This is outside the requested Sprint 40 file scope. Confirm whether it is intentional before final commit/merge.

## 3) Acceptance criteria coverage

### AC1 — Project-scoped diagnostics shape/counts

**Covered.** Diagnostics are project-scoped and expose the expected fields:

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
- optional `lastError`

Implementation reference:

- `ts/packages/runtime/src/file-search-db.ts:788-866`

### AC2 — Diagnostics state/rules

**Covered.** State, `failures === failedChunks`, `refreshNeededChunks = missingChunks + incompatibleChunks + failedChunks`, and ascending `actualDimensions` are implemented and covered by focused tests.

Implementation references:

- `ts/packages/runtime/src/file-search-db.ts:831-846`
- `ts/packages/runtime/src/file-search-db.ts:854-862`

### AC3 — Same-basename project isolation

**Covered.** Refresh and diagnostics derive project identity from full project base dir and query by `project_key`, not basename. Focused tests cover same-basename sibling projects.

Implementation references:

- `ts/packages/runtime/src/file-search-db.ts:791-795`
- `ts/packages/runtime/src/file-search-db.ts:872-885`

### AC4 — `status` and `scan` do not refresh embeddings

**Covered.** CLI status/scan open with `fileSearchScanOnOpen: false` and do not call `refreshSemanticIndex`. Status includes diagnostics through `scanner.embeddings` without generating embeddings.

Implementation references:

- `ts/packages/runtime/src/cli.ts:256-263`
- `ts/packages/runtime/src/cli.ts:290-300`
- `ts/packages/runtime/src/file-search-db.ts:969-988`

### AC5 — No hidden refresh on semantic/hybrid search; return semantic metadata

**Covered.** No hidden semantic refresh occurs. Semantic/hybrid responses include semantic metadata. The previous double-embedding metadata issue is resolved.

Implementation references:

- `ts/packages/runtime/src/cli.ts:303-310`
- `ts/packages/runtime/src/pi-extension.ts:262-273`
- `ts/packages/runtime/src/file-search-query.ts:179-205`
- `ts/packages/runtime/src/file-search-query.ts:220-225`

### AC6 — Explicit project-scoped refresh command/tool

**Covered.** CLI command `file-search-semantic-refresh` and Pi tool `byomem_file_search_semantic_refresh` exist, open without scanning, and call `refreshSemanticIndex` for the target project.

Implementation references:

- `ts/packages/runtime/src/cli.ts:281-288`
- `ts/packages/runtime/src/pi-extension.ts:820-846`
- `ts/packages/runtime/src/file-search-db.ts:868-910`

### AC7 — Exclude stale/wrong-provider/wrong-model/wrong-dimension/unversioned rows

**Covered.** Query filtering checks project, provider, model, configured dimension, status, current chunk hash, identity version, actual dimension matching query vector, and configured-dimension compatibility.

Implementation references:

- `ts/packages/runtime/src/file-search-query.ts:76-91`

Regression test coverage includes wrong provider, wrong model, wrong configured dimension, wrong actual dimension, and legacy unversioned rows:

- `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts:475-547`

### AC8 — Pi direct paths propagate resolved embedding config including dimension

**Covered.** Direct DB open and active poller wiring pass `embeddingDimension` along with provider/model/timeout.

Implementation references:

- `ts/packages/runtime/src/pi-extension.ts:226-238`
- `ts/packages/runtime/src/pi-extension.ts:917-928`
- `ts/packages/runtime/src/file-search-active-poller.ts:110-117`
- `ts/packages/runtime/src/store.ts:80-90`

### AC9 — Cache identity includes provider/model/configured dimension/effective dimension/text hash/version

**Covered for correctness.** New cache IDs include the version tuple and provider identity.

Implementation references:

- `ts/packages/runtime/src/embedding-client.ts:15-19`
- `ts/packages/runtime/src/file-search-db.ts:780-782`
- `ts/packages/runtime/src/file-search-db.ts:891-900`

Non-blocking caveat:

- Existing old index definitions are not force-recreated under the new composite lookup definition, but primary-key cache identity correctness is intact.

### AC10 — Focused tests and build

**Covered.** Focused Sprint 40 tests passed, the broader listed suites passed, and build passed.

## 4) Recommended fixes before completion

No blocking code fixes are recommended before Sprint 40 completion.

Optional cleanup before commit/merge:

1. Confirm whether untracked `.gemini/` should be committed, ignored, or removed.
2. Optionally add future schema hygiene work to recreate/version the old cache lookup index if query-plan performance matters on upgraded databases.

## 5) Verification recommendations

Already completed during final review:

```bash
npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
npm run build
npm test -- \
  ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts \
  ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts \
  ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
  ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts \
  ts/packages/runtime/tests/byomem-extension-wiring.test.ts \
  ts/packages/runtime/tests/cli.test.ts \
  ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
```

Suggested final pre-merge checks:

```bash
git status --short
npm run build
npm test -- ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
```

If time allows, run the full repository test suite once before merge.
