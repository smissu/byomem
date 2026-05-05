# Sprint 42: File-Search Source Line Ranges

## Objective

Add source line-number ranges to BYOMem file-search results so search hits are directly actionable for coding-agent navigation, citation, and patch planning. Preserve existing `chunk_index` compatibility while making clear that chunk indexes are not source line numbers.

## Scope

### In Scope

- Add scanner-derived physical source line metadata to indexed file-search chunks.
- Return line ranges from BM25, semantic, and hybrid file-search modes when available.
- Expose line ranges through CLI JSON output and Pi extension direct tool output.
- Preserve existing result fields and consumer compatibility.
- Safely handle old file-search DBs that do not yet have line metadata.
- Document that line ranges are index-time locations and should be verified before edits when files may have changed.

### Out of Scope

- Do not redesign ranking, chunk scoring, or embedding similarity.
- Do not expand snippets or return surrounding context by default.
- Do not add a separate location-resolution tool in this sprint.
- Do not require destructive DB rebuilds or force immediate semantic re-embedding solely for line metadata.
- Do not implement broader chunking strategy changes beyond preserving physical line ranges for current chunks.

## Investigation Summary

Relevant implementation files:

- `ts/packages/runtime/src/file-search-db.ts`
  - `chunkContent(content)` currently splits by newline and filters blank lines, producing one chunk per non-empty line while losing original physical line numbers.
  - `indexed_chunks` schema currently stores `chunk_index`, `chunk_text`, and `chunk_hash`, but no line metadata.
  - Existing schema helper `ensureColumn(...)` can support additive nullable migration.
- `ts/packages/runtime/src/file-search-query.ts`
  - `FileSearchHit.file` currently exposes `path`, `chunkIndex`, `chunkText`, `chunkHash`, and scores.
  - BM25 and semantic SELECTs currently read chunk metadata but not line ranges.
- `ts/packages/runtime/src/pi-extension.ts`
  - `serializeFileSearchResult(...)` currently emits `chunk_index`, `chunk_text`, `chunk_hash`, and scores.
- `ts/packages/runtime/src/cli.ts`
  - CLI prints raw `FileSearchHit` JSON, so result shape updates flow through directly.
- Relevant tests:
  - `ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts`
  - `ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts`
  - `ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts`
  - `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`
  - `ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts`
  - new target: `ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts`

Current repo state note:

- Sprint 41 work is currently uncommitted and touches shared file-search files including `file-search-db.ts`, `store.ts`, `file-search-active-poller.ts`, `pi-extension.ts`, `cli.ts`, tests, and docs.
- Sprint 42 implementation must not start until Sprint 41 is committed, reverted, or explicitly adopted as the Sprint 42 baseline.

## Acceptance Criteria

- **AC-1:** Indexed chunks store 1-based physical source line ranges as `start_line` / `end_line` or equivalent internal fields.
- **AC-2:** Blank lines are counted correctly when deriving physical line numbers; `chunk_index` is not treated as a source line.
- **AC-3:** Current one-non-empty-line chunk behavior is preserved unless explicitly changed by a later sprint.
- **AC-4:** Existing DBs migrate safely: old rows without line metadata remain queryable, public line fields are omitted/undefined when unavailable, and rescanning files populates line ranges.
- **AC-5:** BM25 search results include line ranges when available.
- **AC-6:** Semantic search results include line ranges when available without duplicating line metadata into embedding rows.
- **AC-7:** Hybrid search preserves line ranges through blended result merging.
- **AC-8:** Pi extension `byomem_file_search` output includes snake_case `start_line` and `end_line` fields when available.
- **AC-9:** CLI file-search JSON output includes camelCase `startLine` and `endLine` fields when available.
- **AC-10:** Existing consumers that rely on `chunk_index`, `chunk_text`, `chunk_hash`, or scores continue to work.
- **AC-11:** Documentation states that line ranges are index-time metadata and should be verified before editing if the working tree may have changed since the last scan.

## Field Naming Contract

Use these canonical names unless implementation review identifies a stronger compatibility reason to differ:

- SQLite/internal snake_case columns: `start_line`, `end_line`
- TypeScript `FileSearchHit.file` fields: `startLine`, `endLine`
- Pi direct tool snake_case output: `start_line`, `end_line`
- CLI output currently prints raw `FileSearchHit` JSON, so it should expose `startLine` / `endLine` unless a separate CLI serializer is intentionally introduced in this sprint.
- Unavailable line fields should be omitted/undefined in public result objects/JSON. Do not emit `0`, inferred fallback lines, or `null` unless implementation review intentionally changes the contract and updates RED tests first.

Do not use `chunk_index` as a line-number substitute.

## RED Test Coverage Details

The RED test pass should explicitly cover these behaviors before implementation:

1. **Schema / migration**
   - `indexed_chunks` gains nullable `start_line` and `end_line` columns.
   - Opening an older DB without these columns migrates safely.
   - Migration is idempotent across repeated opens.
   - Existing rows with missing/null line ranges remain searchable and omit/leave undefined public line fields until rescan.

2. **Scanner line accounting**
   - Blank lines are counted as physical source lines even though blank chunks are not indexed.
   - Repeated identical non-empty lines produce distinct chunks with distinct `chunk_index` and source line ranges.
   - Rescanning a file populates line ranges for the current indexed chunks.

3. **Search result payloads**
   - BM25 results include `file.startLine` / `file.endLine` when available.
   - Semantic results include line ranges by joining back to `indexed_chunks` rather than duplicating metadata into embedding rows.
   - Hybrid blended results preserve line ranges through dedup/merge, including when the same chunk appears in both BM25 and semantic result sets.
   - Sensitive/redacted chunk filtering behavior is unchanged by line metadata.

4. **CLI and Pi extension output**
   - CLI JSON includes camelCase `startLine` / `endLine` because CLI emits raw `FileSearchHit` objects today.
   - `byomem_file_search` direct tool output includes snake_case `start_line` / `end_line` and does not leak camelCase fields in the tool DTO.
   - Both surfaces omit unavailable line fields rather than emitting misleading `0` or inferred values.

5. **Test-file organization**
   - Prefer new Sprint 42-specific test files for line-range coverage where practical to reduce conflicts with active Sprint 41 changes in `cli.test.ts` and `sprint-38-file-search-extension-tools.test.ts`.
   - Existing test files may still be updated when needed to lock public CLI/Pi contracts, but only after Sprint 41 overlap is accounted for.

## Execution Mode

**Standard / mostly serial.**

Rationale: the work centers on shared file-search schema and query/result contracts. Tests can be authored first, but implementation should proceed through a shared scanner/schema kernel before query and API surfaces are updated.

## Workstreams

- **WS-A: RED tests** — new Sprint 42 tests plus focused updates to existing scanner/search/extension tests.
- **WS-B: Scanner/schema kernel** — line-aware chunk metadata and additive DB migration.
- **WS-C: Query/API surfacing** — BM25, semantic, hybrid, CLI, and Pi tool output.
- **WS-D: Docs/validation/review** — runbook updates, regression slice, review.

## Phases & Tasks

### Phase 0 — Preflight and RED Tests

- [ ] **0.1** Confirm Sprint 41 baseline and working-tree state before implementation.
  - Role: `codebase-investigator`
  - Deliverable: short note identifying whether Sprint 41 is merged/committed or still active, and which shared files are currently dirty.
  - Depends on: none
  - Verify:
    ```bash
    git status --short
    ```

- [ ] **0.2** Add RED scanner tests for physical line ranges.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts`
  - Deliverable: failing tests proving chunks from files with blank lines and repeated text receive correct 1-based `start_line` / `end_line` values.
  - Depends on: 0.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **0.3** Add RED search payload tests for BM25, semantic, and hybrid modes.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts`
  - Deliverable: failing assertions that all search modes return line ranges when indexed rows have them.
  - Depends on: 0.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **0.4** Add RED compatibility tests for old DB rows without line metadata.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts`
  - Deliverable: failing tests proving old rows remain searchable and omit/null line fields until rescan.
  - Depends on: 0.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **0.5** Add RED Pi extension serialization coverage.
  - Role: `test-engineer`
  - File: `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts` or Sprint 42 test file
  - Deliverable: failing test proving direct tool output includes `start_line` / `end_line` and preserves existing fields.
  - Depends on: 0.3
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

### Phase 1 — Scanner Schema and Line-Aware Chunks

- [ ] **1.1** Add additive indexed chunk line-range schema.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: nullable line columns on `indexed_chunks`, with safe migration via existing schema helper pattern.
  - Depends on: 0.2, 0.4
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **1.2** Refactor chunk generation to preserve physical line numbers.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: chunking returns structured chunks such as `{ text, startLine, endLine }`, skips blank chunks while preserving their contribution to line numbering, and preserves current non-empty-line chunk behavior.
  - Depends on: 1.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **1.3** Store line ranges on rescan without changing chunk identity semantics.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-db.ts`
  - Deliverable: chunk inserts include line metadata while keeping existing `chunk_index`, `chunk_hash`, and embedding invalidation behavior stable.
  - Depends on: 1.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts
    ```

### Phase 2 — Search Result Contract

- [ ] **2.1** Extend file-search row and hit types with line ranges.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-query.ts`
  - Deliverable: internal result shape exposes optional `startLine` / `endLine` while preserving all existing fields.
  - Depends on: 1.3
  - Verify:
    ```bash
    npm run build
    ```

- [ ] **2.2** Return line ranges from BM25 and semantic queries.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/file-search-query.ts`
  - Deliverable: BM25 and semantic SELECTs read line metadata from `indexed_chunks`; hybrid merge preserves it.
  - Depends on: 2.1
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **2.3** Ensure semantic refresh remains line-metadata agnostic.
  - Role: `typescript-coder`
  - Files: `ts/packages/runtime/src/file-search-db.ts`, `ts/packages/runtime/src/file-search-query.ts`
  - Deliverable: embeddings do not duplicate line metadata; search joins back to current indexed chunk rows for line ranges.
  - Depends on: 2.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

### Phase 3 — CLI, Pi Tool, and Docs

- [ ] **3.1** Expose line ranges through Pi extension file-search tool output.
  - Role: `typescript-coder`
  - File: `ts/packages/runtime/src/pi-extension.ts`
  - Deliverable: serialized direct tool output includes `start_line` and `end_line` when present.
  - Depends on: 2.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts
    ```

- [ ] **3.2** Verify CLI output contract for line ranges.
  - Role: `test-engineer`
  - Files: `ts/packages/runtime/tests/cli.test.ts` or new Sprint 42 CLI-focused test file; inspect `ts/packages/runtime/src/cli.ts` only if verification shows raw `FileSearchHit` flow no longer holds.
  - Deliverable: test-only verification that CLI JSON emits `startLine` / `endLine` through raw `FileSearchHit` results. If implementation code is required, split that into a separate `typescript-coder` task before editing `cli.ts`.
  - Depends on: 2.2
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **3.3** Update file-search runbook/docs.
  - Role: `documenter`
  - Files: `docs/semantic-hybrid-document-search-runbook.md`, `docs/README.md`, `docs/pi-memory-roadmap.md`
  - Deliverable: docs describe line-range fields, their index-time nature, and relationship to `chunk_index`.
  - Depends on: 3.1
  - Verify:
    ```bash
    rg -n "startLine|start_line|line range|chunk_index" docs
    ```

### Phase 4 — Regression and Review

- [ ] **4.1** Run focused file-search regression slice.
  - Role: `test-engineer`
  - Deliverable: Sprint 28/29/31/38/40/41/42 file-search tests pass together.
  - Depends on: 3.3
  - Verify:
    ```bash
    npm test -- --run \
      ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts \
      ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts \
      ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts \
      ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts \
      ts/packages/runtime/tests/sprint-40-file-search-semantic-refresh-and-diagnostics.test.ts \
      ts/packages/runtime/tests/sprint-41-file-search-scanner-binary-and-database-exclusion.test.ts \
      ts/packages/runtime/tests/sprint-42-file-search-line-ranges.test.ts
    ```

- [ ] **4.2** Run build and broader validation.
  - Role: `builder`
  - Deliverable: build/test baseline remains green.
  - Depends on: 4.1
  - Verify:
    ```bash
    npm run build
    npm test -- --run
    git diff --check
    ```

- [ ] **4.3** Independent code review.
  - Role: `code-reviewer`
  - Deliverable: review confirms no ranking/embedding regressions, old DB compatibility, clear result contract, and no accidental Sprint 41 behavior changes.
  - Depends on: 4.2
  - Verify: reviewer sign-off with no blockers.

## Risks & Mitigations

- Risk: Sprint 41 uncommitted changes conflict with Sprint 42 edits. -> Mitigation: treat Sprint 41 resolution as an implementation blocker; land, revert, or explicitly baseline Sprint 41 before Sprint 42 code work begins.
- Risk: `chunk_index` continues to be mistaken for source line. -> Mitigation: docs and payload examples explicitly distinguish `chunk_index` from `startLine` / `endLine`.
- Risk: old DB rows lack line metadata. -> Mitigation: make new columns nullable and allow results to omit/null line ranges until rescan.
- Risk: line ranges become stale when files change before rescanning. -> Mitigation: document index-time semantics and preserve existing hashes for verification.
- Risk: semantic embedding refresh is unnecessarily invalidated. -> Mitigation: keep embedding identity/hash behavior unchanged; line metadata lives only on indexed chunk rows.
- Risk: future multi-line chunks need different handling. -> Mitigation: use range fields now, even when current chunks are single non-empty lines.

## Definition of Done

- [ ] All acceptance criteria validated.
- [ ] RED tests added before implementation and pass after implementation.
- [ ] Search results include line ranges in BM25, semantic, and hybrid modes.
- [ ] Pi extension and CLI output expose the new metadata.
- [ ] Existing DBs remain query-compatible.
- [ ] Docs updated to explain line ranges and `chunk_index` semantics.
- [ ] Focused file-search regression, full tests, build, and `git diff --check` pass.
- [ ] Independent code review signs off.
