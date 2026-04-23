# Sprint 31: File Search Refinement and Cleanup

## Objective
Refine and harden the BYOMem file-search stack after Sprints 27–30 by combining a targeted cleanup pass with a constrained feature pass. This sprint improves scheduler/runtime boundaries, path safety, observability, retry behavior, search-hit shaping, and docs/runbook clarity, while also reintroducing semantic retrieval only if cleanly grounded on stable indexed chunks, tuning result quality, and making small chunking/read-path improvements without expanding into watcher-based behavior or major architecture changes.

## Scope
### In scope
- Narrow the scheduler dependency interface to the minimum project-scoped scan/index contract
- Align file-search DB and scheduler path guards to a canonical full-path strategy
- Improve scheduler observability for activation, debounce, backstop, skip, retry, and degradation paths
- Harden scheduler failure/retry behavior so refreshes do not wedge the pipeline
- Preserve indexed metadata in search hits where already available from the indexed corpus
- Clarify and document the current multi-project scheduler semantics for the supported 1–3 active-project model
- Consolidate docs/runbook guidance for the file-search system
- Reintroduce semantic retrieval only if it is truly grounded on stable indexed chunks from Sprint 28 and can be cleanly gated
- Tune search ranking/result quality within the existing FTS-first model
- Tune chunking policy modestly if needed to improve stable retrieval quality without redesigning the indexer architecture; defer if semantic grounding/ranking work consumes the sprint budget
- Add a minimal, read-only inspection surface only if it cleanly reuses existing runtime/query state without broad new UX/API scope; otherwise defer it
- TDD-first RED tests for all cleanup and feature behaviors above

### Out of scope
- Watcher-based behavior or continuous monitoring
- Any memories DB behavior changes
- File DB schema redesign
- New scheduler policy beyond the existing activation/debounce/backstop model
- Expansion beyond the current 1–3 active-project scope
- Semantic retrieval that is not grounded on stable indexed chunks
- Major search UX redesign
- Broad CLI/admin surface expansion beyond a minimal read-only inspection capability

## Dependencies
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-29-file-search-mvp.md`
- `docs/sprint-30-file-index-scheduler-and-hardening.md`
- Existing runtime/test coverage for file DB, scanner/indexer, search, and scheduler flows
- Canonical path/identity conventions already used by the current runtime
- Stable indexed chunk/output contract from Sprint 28
- Current FTS-first search path from Sprint 29

## Investigation Summary
- Sprints 27–30 delivered the separate file-search DB, scanner/indexer MVP, FTS-first search MVP, and scheduler-driven freshness/hardening MVP.
- The system is now functionally complete enough that the next highest-value work is refinement: reducing hidden coupling, making runtime behavior easier to inspect, improving result quality, and only extending features where the underlying contracts are already stable.
- Cleanup work is the safer prerequisite for feature refinement because:
  - scheduler dependency boundaries are broader than necessary,
  - path-guard behavior should align to canonical full-path handling,
  - observability and retry/degradation behavior should be more explicit,
  - search-hit shaping should preserve already-indexed metadata consistently,
  - docs should explain the actual current semantics of the 1–3 project scheduler model.
- Feature refinement is justified only in limited form:
  - semantic retrieval may be reintroduced only if it is truly grounded on the stable indexed chunk/output contract from Sprint 28,
  - ranking/snippet/result shaping can be improved within the existing FTS-first contract,
  - chunking can be tuned only if it remains compatible with the existing indexed corpus assumptions.
- The main risk is scope creep: watcher semantics, scheduler redesign, fake semantic behavior, or broad UX expansion would all exceed the intended sprint boundary.

## Acceptance Criteria
- AC-1: Scheduler code depends only on a narrow, project-scoped scan/index interface rather than broader runtime/store surfaces.
- AC-2: File-search DB and scheduler path guards consistently use canonical full-path behavior and continue to prevent accidental interaction with the memories DB.
- AC-3: Scheduler observability exposes activation, debounce, periodic backstop, skip, retry, and degradation behavior clearly enough for debugging and operator inspection.
- AC-4: Failure/retry handling is hardened so scheduler-driven refreshes do not wedge the file-search pipeline after transient failures.
- AC-5: Search hits preserve indexed metadata already available from the indexed corpus in a stable, test-covered way.
- AC-6: Docs/runbook content clearly describes the supported file-search architecture and the current 1–3 active-project scheduler semantics.
- AC-7: Semantic retrieval is available only when grounded on stable indexed chunks and is otherwise cleanly gated/deferred; no fake semantic fallback remains.
- AC-8: Search result quality is improved within the FTS-first contract through constrained ranking/snippet/result-shaping tuning, with the specific quality target defined by test coverage.
- AC-9: Any chunking-policy adjustment remains compatible with the current indexed corpus contract and is covered by tests.
- AC-10: Any inspection surface delivered in this sprint is read-only, minimal, and does not expand into a broader control plane.
- AC-11: RED tests define each cleanup and feature contract before implementation.
- AC-12: Sprint 27–30 behavior remains green and unchanged outside the intended cleanup/refinement improvements.

## Execution Mode
parallel

Rationale: the sprint contains two modest workstreams after shared Phase 0 contract locking:
- a cleanup/hardening workstream around scheduler/runtime/docs boundaries,
- a feature refinement workstream around search quality and semantic gating.
These can proceed in parallel only after shared RED tests and contract decisions are established, because the feature work depends on stable chunk/search contracts while the cleanup work depends on stable scheduler/runtime boundaries.

## Workstreams
- **WS-A: Cleanup / Hardening**
  - Paths: scheduler/runtime/path-guard/docs/search-hit-shaping areas
  - Focus: dependency narrowing, path safety, observability, retry hardening, metadata preservation, docs/runbook clarity

- **WS-B: Feature Refinement**
  - Paths: search/query/ranking/chunking/optional inspection areas
  - Focus: semantic gating or clean deferral, ranking/result quality tuning, chunking policy tuning, minimal read-only inspection if low-risk

## Phases & Tasks
### Phase 0 — RED Tests / Shared Contracts / Guardrails
- [ ] **0.1** Add failing tests for the narrow scheduler dependency interface
  - Role: test-engineer
  - Deliverable: RED tests proving scheduler code only uses the minimal project-scoped scan/index contract
  - Depends on: none
  - Verify: targeted scheduler interface tests fail before implementation
- [ ] **0.2** Add failing tests for canonical full-path guard behavior
  - Role: test-engineer
  - Deliverable: RED tests proving path guards normalize/compare canonical full paths and continue excluding memories DB/internal paths
  - Depends on: none
  - Verify: targeted path/boundary tests fail before implementation
- [ ] **0.3** Add failing tests for scheduler observability and retry/degradation behavior
  - Role: test-engineer
  - Deliverable: RED tests covering activation, debounce, backstop, retry, skip, and degradation signals plus non-wedging behavior
  - Depends on: none
  - Verify: targeted scheduler observability/failure-path tests fail before implementation
- [ ] **0.4** Add failing tests for preserving indexed metadata in search hits
  - Role: test-engineer
  - Deliverable: RED tests proving returned search hits retain expected indexed metadata when available
  - Depends on: none
  - Verify: targeted search-hit shaping tests fail before implementation
- [ ] **0.5** Add failing tests for semantic eligibility and hard gating on stable indexed chunks
  - Role: test-engineer
  - Deliverable: RED tests proving semantic retrieval activates only when stable indexed chunks/output and their semantic artifacts are present and valid
  - Depends on: none
  - Verify: targeted semantic-gating tests fail before implementation
- [ ] **0.6** Add failing tests for ranking-quality expectations and chunking-policy behavior
  - Role: test-engineer
  - Deliverable: RED tests covering representative FTS-first/hybrid ranking expectations and stable chunk-boundary behavior
  - Depends on: 0.5
  - Verify: targeted ranking/chunking tests fail before implementation

### Phase 1 — Cleanup / Hardening Core
- [ ] **1.1** Narrow the scheduler dependency interface to the minimal project-scoped scan/index boundary
  - Role: backend-coder
  - Deliverable: refactored scheduler wiring with reduced coupling and explicit dependency surface
  - Depends on: 0.1
  - Verify: scheduler interface tests pass and existing scheduler behavior remains green
- [ ] **1.2** Align DB/scheduler path guards to canonical full-path resolution
  - Role: backend-coder
  - Deliverable: unified path normalization/guard logic for file-search DB and scheduler boundaries
  - Depends on: 0.2, 1.1
  - Verify: path/boundary tests pass and no memories DB regressions appear
- [ ] **1.3** Improve observability and harden retry/degradation handling for scheduler-driven refresh
  - Role: backend-coder
  - Deliverable: explicit metrics/logging/state reporting plus stronger retry/non-wedging behavior
  - Depends on: 0.3, 1.1
  - Verify: observability/failure-path tests pass
- [ ] **1.4** Preserve indexed metadata in search-hit shaping
  - Role: backend-coder
  - Deliverable: stable search-hit result shaping that includes already-indexed metadata where available
  - Depends on: 0.4
  - Verify: search-hit metadata tests pass

### Phase 2 — Feature Refinement Core
- [ ] **2.1** Implement or finalize grounded semantic retrieval over stable indexed chunks only
  - Role: backend-coder
  - Deliverable: semantic retrieval path that consumes only persisted, stable indexed chunk/output artifacts and stays disabled otherwise
  - Depends on: 0.5, 1.4
  - Verify: semantic-gating tests pass; unstable/unavailable semantic inputs do not activate semantic search
- [ ] **2.2** Tune ranking policy for FTS-first plus grounded semantic blending
  - Role: backend-coder
  - Deliverable: ranking logic that preserves FTS-first behavior while improving result quality when grounded semantic evidence exists
  - Depends on: 0.6, 2.1
  - Verify: ranking-quality tests pass and project scoping remains intact
- [ ] **2.3** Tune chunking policy for better retrieval quality without breaking index stability
  - Role: backend-coder
  - Deliverable: updated chunking rules/thresholds that improve retrieval inputs while preserving stable indexed output semantics
  - Depends on: 0.6
  - Verify: chunking-policy tests pass and existing indexing/search regressions do not appear
- [ ] **2.4** Add a minimal read-only inspection surface only if implementation remains low-risk and cleanly bounded
  - Role: builder
  - Deliverable: small inspection command/output for indexed chunk/search-state visibility, only if it reuses stable runtime artifacts cleanly
  - Depends on: 2.1, 2.2, 2.3
  - Verify: targeted tests or documented output checks pass
  - Note: defer entirely if it introduces new contracts, storage, or UX complexity

### Phase 3 — Integration / Docs / Regression Closure
- [ ] **3.1** Consolidate docs and runbook guidance for the current file-search stack
  - Role: documenter
  - Deliverable: updated docs describing DB separation, scanner/indexer/search flow, scheduler freshness model, current 1–3 active-project semantics, and semantic gating rules
  - Depends on: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3
  - Verify: doc review confirms current behavior is clearly and accurately described
- [ ] **3.2** Add end-to-end integration verification across FTS-only, gated-semantic-off, and grounded-semantic-on retrieval cases
  - Role: test-engineer
  - Deliverable: integration coverage showing correct behavior across supported retrieval modes
  - Depends on: 2.1, 2.2, 2.3
  - Verify: end-to-end retrieval tests pass
- [ ] **3.3** Add focused regression verification across Sprint 27–30 behavior after refinement changes
  - Role: test-engineer
  - Deliverable: validation evidence that cleanup/feature changes did not regress file DB, scanner/indexer, search, or scheduler MVP behavior
  - Depends on: 3.1, 3.2
  - Verify: targeted regression suite passes cleanly

## Verification
- Run targeted scheduler interface tests proving dependency narrowing is real.
- Run canonical path/boundary tests proving full-path normalization and continued memories DB exclusion.
- Run scheduler observability/failure-path tests proving activation, debounce, backstop, retry, skip, and degradation states are surfaced and non-wedging.
- Run search-hit shaping tests proving indexed metadata is preserved where available.
- Run semantic-gating tests proving semantic retrieval activates only when grounded on stable indexed chunks and remains cleanly deferred otherwise.
- Run ranking/chunking tests proving result quality improvements without breaking FTS-first correctness or index stability.
- Run end-to-end retrieval tests for FTS-only, semantic-gated-off, and semantic-gated-on paths.
- Run focused regression coverage for Sprint 27–30 behavior to confirm no refinement-induced regressions.
- Review docs/runbook updates for alignment with actual implementation behavior.

## Risks & Mitigations
- **Risk:** cleanup work drifts into scheduler redesign rather than refinement.  
  **Mitigation:** keep scheduler policy unchanged and focus only on dependency narrowing, observability, retry hardening, and semantic clarity.
- **Risk:** semantic retrieval is reintroduced without true grounding.  
  **Mitigation:** gate semantic behavior behind stable indexed chunk prerequisites and keep it disabled if those prerequisites are not satisfied.
- **Risk:** ranking/chunking tuning destabilizes the existing FTS-first path.  
  **Mitigation:** preserve FTS-first as the default contract and require regression coverage for current indexed/search behavior.
- **Risk:** optional inspection surface expands into a broader product/API effort.  
  **Mitigation:** keep inspection read-only and defer it entirely if it requires new contracts or control-plane semantics.
- **Risk:** cleanup and feature workstreams conflict on shared query/index contracts.  
  **Mitigation:** lock shared RED tests and shared contract assumptions in Phase 0 before allowing parallel Phase 1/2 work.

## Definition of Done
- [ ] All acceptance criteria are satisfied and backed by passing tests.
- [ ] Cleanup/hardening goals land without changing Sprint 27–30 behavior outside the intended refinements.
- [ ] Semantic retrieval is either correctly grounded and enabled or cleanly gated/deferred with explicit test coverage.
- [ ] Ranking/chunking improvements are test-covered and preserve the FTS-first contract.
- [ ] Docs/runbook guidance accurately describes the delivered system behavior.
- [ ] Focused Sprint 27–30 regressions remain green after this sprint.
- [ ] Review sign-off confirms no watcher creep, no fake semantic behavior, and no unintended scheduler redesign.

## See Also
- `docs/sprint-27-global-file-search-db-foundation.md`
- `docs/sprint-28-file-scanner-indexer-mvp.md`
- `docs/sprint-29-file-search-mvp.md`
- `docs/sprint-30-file-index-scheduler-and-hardening.md`
