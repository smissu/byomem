# Sprint 32: Semantic / Hybrid Document Search

## Objective
Implement true semantic and hybrid search for the BYOMem document/file-search stack by embedding stable indexed file chunks and querying them with the same embedding-client approach already used by memory search. The sprint keeps FTS-first behavior intact, adds Ollama-compatible semantic retrieval over persisted chunk embeddings, and makes hybrid ranking the optimized path for document search when embeddings are available.

## Scope
### In scope
- Add a file-search embedding schema for indexed chunks in the separate file-search DB
- Reuse the existing TS embedding client and default remote model behavior (`nomic-embed-text`) for file/document chunk embeddings
- Embed only stable indexed chunks and avoid re-embedding unchanged chunks via chunk/text hash caching
- Add a bounded backfill/resume path for existing `indexed_chunks` that lack embeddings
- Track embedding coverage/status per chunk/model so partial coverage is visible and testable
- Keep semantic indexing/search explicitly enableable/configurable so FTS-only document search remains the safe default when embeddings are not configured
- Define batch size, timeout, and partial-batch failure behavior for embedding generation
- Add `semantic` mode to document search and make `hybrid` combine FTS and semantic evidence
- Preserve `fts` mode as the deterministic lexical baseline
- Keep project scoping mandatory for all FTS, semantic, and hybrid file-search results
- Handle unavailable Ollama/remote embedding service cleanly without wedging scanner/indexer or breaking FTS search
- Add explicit RED tests before implementation for schema, embedding, semantic retrieval, hybrid ranking, fallback, and regression behavior
- Add docs/runbook guidance for configuring and testing semantic document search
- Keep live Ollama usage out of normal automated tests by using mocked/fake embeddings; live Ollama smoke tests should be explicit/manual or skippable
- Propagate embedding configuration from `NativeStoreOptions`, CLI flags, Pi extension config/env, and file-search DB opening into document embedding/indexing paths
- Add a minimal public runtime/CLI/API surface for selecting document search modes so semantic/hybrid document search can be tested without private imports
- Explicitly resolve the async boundary between the current synchronous scanner/indexer API and async embedding generation, preferably through a bounded awaited embedding refresh/backfill path rather than hidden fire-and-forget work

### Out of scope
- Replacing SQLite FTS5 as the lexical search baseline
- Changing the memories DB or memory search semantics except for reusing shared embedding utilities
- Broad CLI/tool productization beyond minimal API/config plumbing required for testing; Sprint 32 should add only the minimal mode-selection/search surface needed to exercise document semantic/hybrid search
- Watcher-based indexing or long-running scanner daemon behavior
- Large chunking redesign beyond preserving compatibility with the existing stable chunk contract
- Bulk migration of old indexes outside normal rescan/backfill behavior
- Production-grade approximate nearest neighbor indexing; brute-force cosine over the MVP chunk set is acceptable if bounded and tested
- Full observability platform work beyond minimal counters/diagnostics needed to troubleshoot embedding coverage and fallback behavior
- Production-grade latency SLOs or large-corpus vector indexing beyond documented MVP assumptions and safeguards

## Investigation Summary
- Scanner stopped/inactive: current file-search scanning is synchronous during `openNativeStore({ baseDir })` / `openFileSearchDb()` and there is no background scanner process to stop.
- Current document/file-search indexing lives in `ts/packages/runtime/src/file-search-db.ts` and stores stable chunks in `indexed_chunks` plus FTS5 rows in `indexed_chunks_fts`.
- Current document search lives in `ts/packages/runtime/src/file-search-query.ts`; it supports `mode?: 'fts' | 'hybrid'`, but `hybrid` currently returns FTS hits when present and otherwise returns `[]`.
- Current memory search already has semantic/hybrid behavior in `ts/packages/runtime/src/sqlite-sidecar-internal.ts`, using `record_embeddings`, `embedding_cache`, cosine similarity, and `openEmbeddingClient()`.
- Memory-sidecar vector helpers such as embedding BLOB encode/decode, cosine similarity, and text truncation are currently private to `sqlite-sidecar-internal.ts`; Sprint 32 should extract shared utilities rather than importing private sidecar internals from file-search code.
- Existing embedding client lives in `ts/packages/runtime/src/embedding-client.ts`; it supports Ollama-compatible `/api/embeddings`, defaults to `nomic-embed-text`, supports timeout/remote-required behavior, and has deterministic fallback embeddings when remote embeddings are not required.
- `NativeStoreOptions` and CLI parsing already include embedding configuration fields: `embeddingBaseUrl`, `embeddingModel`, `embeddingDimension`, `embeddingTimeoutMs`, and `embeddingRequireRemote`.
- `openNativeStore()` currently passes embedding options to the memory sidecar but opens file search with only `openFileSearchDb({ baseDir })`; Sprint 32 must explicitly wire embedding options into the file-search DB/indexer path.
- Pi extension embedding config already resolves `BYOMEM_EMBEDDING_BASE_URL`, `BYOMEM_EMBEDDING_MODEL`, `BYOMEM_EMBEDDING_TIMEOUT_MS`, and YAML embedding config, but today those settings affect memory embeddings rather than file-search chunk embeddings.
- CLI `search` currently imports memory `search-index.ts`, not `file-search-query.ts`; Sprint 32 needs a bounded public/manual entrypoint for document search modes if semantic/hybrid document search is to be user-testable.
- The file-search DB is intentionally physically separate from the memories DB, so document chunk embeddings must be stored in the file-search DB, not in `record_embeddings`.
- Recent scanner hardening in commit `3e7d5c0` makes root project scans practical by honoring `.gitignore`; Sprint 32 should preserve that behavior.
- Current file-search scan APIs such as `scanAndIndex(): void` are synchronous, while Ollama/embedding generation is async; Sprint 32 must define an explicit awaited indexing/embedding refresh boundary instead of hiding async work behind unawaited scanner side effects.

## Acceptance Criteria
- AC-1: File-search DB schema includes persisted chunk embeddings, embedding cache/metadata, model name, dimension, text/chunk hash, and update timestamps without touching the memories DB schema.
- AC-2: Scanner/indexer embeds stable indexed chunks using the existing embedding client when semantic indexing is enabled/configured, and it skips re-embedding unchanged chunks.
- AC-3: If Ollama/remote embeddings are unavailable, indexing/search degrades safely according to configuration: FTS remains usable, no partial write corrupts the file-search DB, and remote-required mode fails loudly in tests.
- AC-4: Document search supports explicit `mode: 'fts'`, `mode: 'semantic'`, and `mode: 'hybrid'` with stable typed results.
- AC-5: Semantic document search can return relevant chunk hits when lexical FTS would miss, using persisted chunk embeddings scoped to the current project.
- AC-6: Hybrid document search combines FTS score and semantic score so lexical hits remain strong while semantically relevant chunks can improve ranking or fill gaps.
- AC-7: All file-search modes enforce project scoping and do not leak chunks across project keys or into the memories DB.
- AC-8: Embedding cache/reuse behavior is test-covered: unchanged chunks are not re-embedded; changed chunks are re-embedded; deleted chunks remove stale embedding rows.
- AC-9: Existing Sprint 27–31 FTS/scanner/scheduler behavior remains green and unchanged outside the intended semantic/hybrid additions.
- AC-10: Documentation explains required Ollama setup, default model (`nomic-embed-text`), configuration options, fallback behavior, and manual verification steps.
- AC-11: RED tests are committed/recorded before implementation work, and verification includes focused semantic/hybrid tests plus full regression/build.
- AC-12: Existing `indexed_chunks` without embeddings can be backfilled in bounded/resumable batches, and model/version changes do not silently reuse incompatible embeddings.
- AC-13: Automated semantic/hybrid tests use mocked/fake embeddings and do not require live Ollama unless explicitly marked as a manual/skippable smoke test.
- AC-14: Minimal diagnostics expose embedding coverage, failures/fallbacks, configured model/dimension, and enough search degradation information to troubleshoot missing semantic results.
- AC-15: Embedding configuration is consistently propagated into file-search indexing/search from existing runtime, CLI, and Pi extension configuration paths without duplicating Ollama client logic.
- AC-16: A minimal public runtime/CLI/API entrypoint supports document search mode selection (`fts`, `semantic`, `hybrid`) and returns structured file/chunk metadata suitable for manual testing.
- AC-17: Async embedding generation is exposed through an explicit awaited refresh/backfill path; no semantic embedding work is hidden in unawaited synchronous scanner calls.
- AC-18: Semantic document indexing/search can be disabled or left unconfigured without breaking existing FTS document search, and remote-required behavior is explicit.
- AC-19: Hybrid/semantic result limits, deduplication, score normalization, tie-breaking, and pagination/limit semantics are deterministic and test-covered.
- AC-20: Sprint documentation includes Ollama setup with the model pull command, expected config, MVP corpus/latency assumptions, and known limitations.

## Execution Mode
parallel

Rationale: the sprint has a shared schema/config/test kernel, then separable workstreams for indexing/embedding, query/ranking, and docs/manual verification. Parallel work is only safe after Phase 0 locks shared contracts and schema expectations.

## Workstreams
- **WS-A: Embedding Schema / Scanner Integration**
  - Paths: `ts/packages/runtime/src/file-search-db.ts`, new/updated file-search embedding helpers, scanner/indexer tests
  - Focus: schema, chunk embedding persistence, cache/reuse, rescan/deletion behavior, Ollama unavailable handling

- **WS-B: Query / Ranking Integration**
  - Paths: `ts/packages/runtime/src/file-search-query.ts`, possible shared cosine/ranking utility, query tests
  - Focus: `semantic` mode, `hybrid` blending, project scoping, typed result metadata and scores

- **WS-C: Docs / Configuration / Verification**
  - Paths: docs/runbook/index/roadmap and optional CLI/config notes
  - Focus: operator setup for Ollama, default model, manual test commands, fallback expectations

- **WS-D: Public Runtime / CLI/API Surfacing**
  - Paths: `ts/packages/runtime/src/cli.ts`, `ts/packages/runtime/src/pi-extension.ts`, `ts/packages/runtime/src/index.ts`, and public query exports as needed
  - Focus: minimal document-search mode selection and configuration propagation without broad productization

## Phases & Tasks
### Phase 0 — RED Tests / Shared Contracts / Guardrails
- [ ] **0.1** Add failing schema tests for file-search chunk embeddings in `ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests proving file-search DB owns chunk embedding/cache tables with model, dimension, chunk hash/text hash, and timestamps, and that these tables are not created in the memories sidecar
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts` fails before schema implementation

- [ ] **0.2** Add failing scanner embedding/cache lifecycle tests in `ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests proving stable chunks are embedded, unchanged chunks reuse cached embeddings, changed chunks re-embed, and deleted chunks remove stale embedding rows
  - Depends on: 0.1
  - Verify: schema/lifecycle Sprint 32 test fails for missing embedding persistence/reuse behavior

- [ ] **0.3** Add failing semantic and hybrid query tests in `ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`
  - Role: test-engineer
  - Deliverable: RED tests with mocked `fetch` embeddings proving semantic-only lexical-miss retrieval, hybrid ranking/blending, low-similarity exclusion, and project scoping
  - Depends on: 0.1
  - Verify: query Sprint 32 test fails for missing `semantic` mode and true hybrid behavior

- [ ] **0.4** Add failing remote-unavailable/fallback tests for file-search embeddings
  - Role: test-engineer
  - Deliverable: RED tests proving FTS remains usable when remote embeddings are unavailable and remote-required mode fails loudly without corrupting file-search state
  - Depends on: 0.2, 0.3
  - Verify: Sprint 32 schema/query tests fail for missing degradation behavior

- [ ] **0.5** Define shared result/scoring contract for document semantic/hybrid search
  - Role: planner + test-engineer
  - Deliverable: documented test expectations for result fields such as `file.path`, `chunkIndex`, `chunkHash`, optional score/provenance metadata, and deterministic tie-breaking
  - Depends on: 0.3
  - Verify: test assertions are stable and avoid overfitting to implementation internals

- [ ] **0.6** Add failing tests for backfill, model-version changes, and embedding diagnostics
  - Role: test-engineer
  - Deliverable: RED tests proving existing chunks can be embedded in bounded batches, changed model/dimension creates fresh embedding state, and diagnostics expose coverage/failure/fallback counts
  - Depends on: 0.1, 0.2
  - Verify: focused Sprint 32 test fails before backfill/version/diagnostic implementation

- [ ] **0.7** Add failing tests for embedding config propagation and minimal public document-search surfacing
  - Role: test-engineer
  - Deliverable: RED tests proving runtime/CLI/Pi config reaches file-search embeddings and that a public/manual entrypoint can run `fts`, `semantic`, and `hybrid` document search modes without private imports
  - Depends on: 0.3, 0.4
  - Verify: focused config/API tests fail before implementation; likely targets include `ts/packages/runtime/tests/cli.test.ts`, `ts/packages/runtime/tests/byomem-extension-wiring.test.ts`, or a focused Sprint 32 public-surface test

- [ ] **0.8** Add failing tests for the async embedding refresh/backfill boundary
  - Role: test-engineer
  - Deliverable: RED tests proving callers can await semantic chunk embedding/backfill completion and that synchronous scanner calls do not start hidden unawaited embedding work
  - Depends on: 0.2, 0.6
  - Verify: focused async-boundary tests fail before implementation

- [ ] **0.9** Add failing tests for enablement, batching, limit/pagination, and partial-failure semantics
  - Role: test-engineer
  - Deliverable: RED tests proving FTS-only remains safe when semantic search is disabled/unconfigured, embedding batches respect configured bounds, partial failures are recorded/degraded deterministically, and result limits/deduplication are stable
  - Depends on: 0.3, 0.4, 0.8
  - Verify: focused Sprint 32 tests fail before enablement/batching/limit semantics are implemented

- [ ] **0.10** Update legacy semantic-gating expectations from Sprint 29/31 for the new grounded semantic path
  - Role: test-engineer
  - Deliverable: revise tests that currently assert semantic file search is deferred so they continue to assert no fake semantic fallback when embeddings are absent, while allowing true semantic results when persisted chunk embeddings are present
  - Depends on: 0.3, 0.4
  - Verify: `ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts` and `ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts` fail appropriately before implementation and pass after grounded semantic support lands

### Phase 1 — Embedding Schema and Scanner Integration
- [ ] **1.0** Extract shared vector helpers from memory sidecar internals
  - Role: typescript-coder
  - Deliverable: shared utility module for embedding BLOB encode/decode, cosine similarity, and embedding text truncation reused by both memory and file-search paths
  - Depends on: 0.1, 0.3
  - Verify: existing memory semantic tests remain green and new file-search tests can use the shared helpers without importing sidecar internals

- [ ] **1.1** Add file-search embedding schema and migration markers in `ts/packages/runtime/src/file-search-db.ts`
  - Role: backend-coder
  - Deliverable: tables/indexes for chunk embeddings/cache with model/dimension/hash metadata, separate from memories DB tables
  - Depends on: 0.1, 1.0
  - Verify: schema tests pass; Sprint 27 DB-separation tests remain green

- [ ] **1.2** Wire embedding-client configuration into file-search DB opening/indexing
  - Role: typescript-coder
  - Deliverable: `openFileSearchDb`/`openNativeStore` path can pass embedding base URL/model/dimension/timeout/remote-required settings to document indexing without duplicating client logic
  - Depends on: 1.1, 0.7
  - Verify: configuration/mocked fetch tests pass; existing memory embedding tests remain green

- [ ] **1.3** Persist embeddings for stable indexed chunks during scan/index
  - Role: backend-coder
  - Deliverable: scanner embeds chunk text after stable chunk creation and records embedding rows keyed by chunk identity/hash/model
  - Depends on: 1.1, 1.2, 0.2
  - Verify: scanner embedding tests pass with mocked Ollama embeddings

- [ ] **1.4** Implement cache/reuse/reconciliation behavior for chunk embeddings
  - Role: backend-coder
  - Deliverable: unchanged chunks avoid remote re-embedding, changed chunks update embeddings, deleted chunks prune stale embedding rows
  - Depends on: 1.3
  - Verify: cache/reuse/deletion tests pass and Sprint 28 reconciliation tests remain green

- [ ] **1.5** Harden embedding failure behavior for document indexing
  - Role: backend-coder
  - Deliverable: remote-unavailable behavior follows config, leaves FTS indexing usable where allowed, and avoids corrupting embedding rows
  - Depends on: 1.3, 0.4
  - Verify: remote-unavailable/fallback tests pass

- [ ] **1.6** Implement bounded embedding backfill, model-version handling, and minimal diagnostics
  - Role: backend-coder
  - Deliverable: resumable/bounded embedding backfill for existing chunks, model/dimension-aware cache invalidation, and coverage/failure/fallback diagnostics
  - Depends on: 1.4, 1.5, 0.6
  - Verify: backfill/model-version/diagnostics tests pass

- [ ] **1.7** Implement explicit awaited semantic indexing/embedding refresh API
  - Role: backend-coder
  - Deliverable: public/internal API for awaiting chunk embedding generation after stable chunks exist, usable by tests and manual workflows without converting the scanner into a daemon
  - Depends on: 1.6, 0.8
  - Verify: async-boundary tests pass and existing synchronous scanner tests remain green

- [ ] **1.8** Implement semantic enablement, batch sizing, and partial-failure accounting
  - Role: backend-coder
  - Deliverable: config-gated semantic indexing/search, bounded embedding batches, timeout-aware failure handling, and diagnostics for partial batch failures
  - Depends on: 1.7, 0.9
  - Verify: enablement/batching/partial-failure tests pass

### Phase 2 — Semantic and Hybrid Query Implementation
- [ ] **2.1** Add `semantic` mode to `FileSearchQuery` in `ts/packages/runtime/src/file-search-query.ts`
  - Role: typescript-coder
  - Deliverable: typed `mode: 'semantic'` path that embeds query text and returns project-scoped chunk hits from persisted embeddings
  - Depends on: 1.1, 1.2, 0.3
  - Verify: semantic lexical-miss test passes

- [ ] **2.2** Implement cosine scoring and deterministic ordering for file chunk embeddings
  - Role: typescript-coder
  - Deliverable: semantic result scoring with thresholding/tie-breaking that is stable under tests and compatible with existing result shape
  - Depends on: 2.1
  - Verify: semantic ranking tests pass with mocked vectors

- [ ] **2.3** Implement true hybrid FTS + semantic blending for document search
  - Role: backend-coder
  - Deliverable: `mode: 'hybrid'` combines FTS and semantic candidates, normalizes lexical/vector scores, dedupes by chunk identity, preserves FTS-first strength, and allows semantic evidence to improve ranking/fill gaps
  - Depends on: 2.1, 2.2, 0.3, 0.9
  - Verify: hybrid ranking/blending/limit tests pass

- [ ] **2.4** Preserve strict project scoping across semantic and hybrid modes
  - Role: backend-coder
  - Deliverable: all embedding candidate queries filter by `project_key` and never read memory-sidecar tables
  - Depends on: 2.1, 2.3
  - Verify: cross-project leakage tests pass; Sprint 29 project-scoping tests remain green

- [ ] **2.5** Add minimal public runtime/CLI/API surfacing for document search mode selection
  - Role: typescript-coder
  - Deliverable: public/manual entrypoint for document search that accepts `mode: fts|semantic|hybrid`, uses existing embedding config conventions, and returns structured file/chunk metadata without replacing memory `byomem_search`
  - Depends on: 2.4, 0.7
  - Verify: CLI/API/config tests pass and manual smoke command can run without private imports

### Phase 3 — Integration / Regression / Operator Docs
- [ ] **3.1** Add focused integration tests for FTS-only, semantic-only, hybrid, unavailable-remote, rescan/cache, backfill, model-version, diagnostics, async refresh, enablement/batching, limits, and public surfacing scenarios
  - Role: test-engineer
  - Deliverable: complete Sprint 32 focused suite covering AC-1 through AC-20 without requiring live Ollama
  - Depends on: 1.8, 2.5
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`

- [ ] **3.2** Run Sprint 27–32 file-search regression suite
  - Role: test-engineer
  - Deliverable: regression evidence that DB foundation, scanner, gitignore, FTS MVP, scheduler, and refinement behavior remain green
  - Depends on: 3.1
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-27-file-search-db-foundation.test.ts ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`

- [ ] **3.3** Update docs/runbook for semantic/hybrid document search
  - Role: documenter
  - Deliverable: docs explaining Ollama setup, `ollama pull nomic-embed-text`, default model, configuration fields, semantic enablement, indexing/search modes, fallback behavior, MVP corpus/latency assumptions, and manual smoke tests
  - Depends on: 1.8, 2.5
  - Verify: docs review confirms behavior matches implementation

- [ ] **3.4** Update docs index and roadmap references for Sprint 32
  - Role: documenter
  - Deliverable: `docs/README.md` and `docs/pi-memory-roadmap.md` link Sprint 32 in the file-search sequence
  - Depends on: sprint artifact creation
  - Verify: links resolve and docs index remains ordered

- [ ] **3.5** Run full suite and build
  - Role: test-engineer
  - Deliverable: final verification evidence for sprint closeout
  - Depends on: 3.1, 3.2, 3.3
  - Verify: `npm test -- --run` and `npm run build`

## Verification
- Focused Sprint 32 RED/GREEN suite: `npm test -- --run ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts`
- File-search regression suite across Sprints 27–32, including gitignore scanner coverage and the updated Sprint 29/31 semantic-gating expectations
- Existing memory semantic tests such as `ts/packages/runtime/tests/sqlite-sidecar.test.ts`, `ts/packages/runtime/tests/search-parity-regression.test.ts`, and `ts/packages/runtime/tests/embedding-client.test.ts` remain green
- Full runtime suite: `npm test -- --run`
- Build: `npm run build`
- Manual smoke test against BYOMem repo root with Ollama running and `embeddingBaseUrl` configured, verifying:
  - FTS search still works
  - semantic search returns non-lexical relevant chunks
  - hybrid search returns optimized blended results
  - minimal public runtime/CLI/API entrypoint can select `fts`, `semantic`, and `hybrid` document modes
  - ignored directories remain excluded
  - embedding coverage/diagnostics report expected model, dimension, coverage, and fallback state

## Risks & Mitigations
- **Risk:** embedding every chunk can be slow or expensive on large repos.  
  **Mitigation:** cache by chunk/text hash and model, skip unchanged chunks, support bounded/resumable backfill batches, define MVP corpus/latency assumptions, preserve FTS-only usability, and defer ANN/vector-index optimization until needed.
- **Risk:** remote Ollama outages, missing models, timeouts, bad responses, or partial batch failures could wedge indexing.  
  **Mitigation:** make failure behavior explicit and test fallback-allowed, remote-required, timeout/bad-response, and partial-batch modes.
- **Risk:** semantic retrieval could leak cross-project chunks.  
  **Mitigation:** require `project_key` filtering in all semantic candidate queries and add cross-project tests.
- **Risk:** file-search embeddings accidentally reuse or mutate memory-sidecar tables.  
  **Mitigation:** keep schema physically in the file-search DB and run Sprint 27 boundary tests.
- **Risk:** hybrid ranking is hard to tune deterministically.  
  **Mitigation:** use mocked embeddings with simple vectors, define deterministic score blending, deduplication, limit/pagination semantics, and tie-breakers, and preserve `fts` mode as baseline.
- **Risk:** embedding fallback vectors may produce misleading semantic quality.  
  **Mitigation:** document fallback as test/dev behavior; prefer remote Ollama for real semantic search; remote-required mode must fail loudly; automated tests should mock embeddings instead of requiring live Ollama.
- **Risk:** async embedding generation is accidentally hidden behind the synchronous scanner, causing races and flaky tests.  
  **Mitigation:** require an explicit awaited refresh/backfill API and tests proving no hidden fire-and-forget semantic work is required for correctness.
- **Risk:** binary/non-UTF8 file reads remain a scanner limitation.  
  **Mitigation:** keep this out of Sprint 32 unless tests expose it as blocking; consider a later binary-skip sprint.
- **Risk:** partial embedding coverage can produce confusing or biased semantic/hybrid results.  
  **Mitigation:** store explicit coverage/status metadata, expose diagnostics, and ensure hybrid/semantic behavior is well-defined when only some chunks have embeddings.
- **Risk:** semantic rollout could break FTS-only file search when embeddings are disabled or unavailable.  
  **Mitigation:** keep semantic indexing/search explicitly enableable/configurable and verify FTS-only remains green without Ollama.
- **Risk:** model drift or dimension changes can silently mix incompatible vectors.  
  **Mitigation:** store model and dimension with every embedding/cache row and force fresh embeddings when model/dimension changes.

## Definition of Done
- [ ] All acceptance criteria are satisfied by passing tests.
- [ ] File-search DB stores chunk embeddings separately from the memories DB.
- [ ] `fts`, `semantic`, and `hybrid` document search modes are implemented and typed.
- [ ] Hybrid search demonstrably improves or supplements FTS results under mocked embedding tests.
- [ ] Unchanged chunks are not re-embedded; changed/deleted chunks update embedding state correctly.
- [ ] Ollama unavailable behavior is explicit, test-covered, and does not break FTS search unexpectedly.
- [ ] Backfill, model-version changes, embedding coverage, and diagnostics are test-covered.
- [ ] Embedding configuration reaches file-search from runtime, CLI, and Pi extension paths.
- [ ] Minimal public runtime/CLI/API surfacing can run document `fts`, `semantic`, and `hybrid` modes without private imports.
- [ ] Async semantic indexing/backfill is explicitly awaited and test-covered; no hidden unawaited scanner embedding work is required.
- [ ] Semantic enablement, batch sizing, partial failures, result limits, dedupe, and deterministic tie-breaking are test-covered.
- [ ] Docs include `ollama pull nomic-embed-text`, config examples, MVP corpus/latency assumptions, and limitations.
- [ ] Automated tests use mocked/fake embeddings; live Ollama checks are documented as manual/skippable smoke tests.
- [ ] Sprint 27–31 regression tests remain green.
- [ ] Full test suite and build pass.
- [ ] Docs/runbook and docs indexes are updated.
- [ ] Independent review confirms no memories DB coupling, no project-scope leakage, and no scanner daemon/watch creep.

## See Also
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-29-file-search-mvp.md`
- `docs/sprint-30-file-index-scheduler-and-hardening.md`
- `docs/sprint-31-file-search-refinement-and-cleanup.md`
- `ts/packages/runtime/src/file-search-db.ts`
- `ts/packages/runtime/src/file-search-query.ts`
- `ts/packages/runtime/src/embedding-client.ts`
- `ts/packages/runtime/src/sqlite-sidecar-internal.ts`
