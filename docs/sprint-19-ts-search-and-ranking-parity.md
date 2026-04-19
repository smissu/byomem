# Sprint 19: TS Search and Ranking Parity

## Objective
Bring the TS-native search and ranking behavior up to parity with the established BYOMem expectations so retrieval quality matches the current Python-backed baseline before write and adapter migration proceeds.

## Scope
- Implement search primitives for lexical and hybrid retrieval.
- Add ranking parity rules for identity, recency, scope, provenance, and context relevance.
- Compare native search outputs against the existing baseline expectations.
- Tighten query-result ordering and scoring tests.

## Non-goals
- Store identity redesign.
- Write-path actions and migration.
- Session capture queue migration.
- Shadow validation and cutover.

## Dependencies
- Sprint 18 native read path and retrieval baseline.
- Sprint 17 stable identity and store.
- Existing ranking expectations from prior docs/tests.

## Investigation Summary
Current repo docs already treat Sprint 18 as the native read-path baseline and Sprint 17 as the stable identity/store foundation. This sprint remains focused on search/ranking parity only, so the work should align TS retrieval behavior with the existing Python-backed expectations without broadening into write or queue migration.

## Acceptance Criteria
- AC-1: Native search returns results ordered according to documented BYOMem ranking expectations.
- AC-2: Identity, recency, scope, provenance, and lexical relevance all influence ranking as intended.
- AC-3: Search parity tests demonstrate the native behavior matches the expected baseline for representative queries.
- AC-4: Search remains deterministic enough for repeatable tests.
- AC-5: The TS search path is the active path for covered scenarios, and Python is no longer required in steady state once this cutover completes.

## Execution Mode
Standard.
Rationale: search and ranking share scoring logic and baseline tests; keeping this as one stream reduces false-positive drift across query types.

## Phases & Tasks
### Phase 0 — Failing parity tests
- [ ] **0.1** Add or expand ranking tests for lexical, hybrid, recency, and scope-sensitive queries in `tests/unit/`
  - Role: test-engineer
  - Deliverable: RED parity tests that capture current expectations.
  - Verify: targeted ranking test command.

- [ ] **0.2** Add representative search fixtures in `tests/fixtures/`
  - Role: typescript-coder
  - Deliverable: query/result fixture set for parity checking.
  - Verify: fixtures are referenced by the new tests.

### Phase 1 — Search/ranking implementation
- [ ] **1.1** Implement TS-native lexical search scoring and candidate generation in `src/`
  - Role: typescript-coder
  - Deliverable: native lexical search primitive.
  - Verify: lexical tests pass.

- [ ] **1.2** Implement ranking rules for recency, identity stability, scope, provenance, and hybrid relevance
  - Role: typescript-coder
  - Deliverable: scoring layer or ranking helper.
  - Verify: ordering tests pass across representative queries.

### Phase 2 — Parity validation and docs
- [ ] **2.1** Run and fix parity regressions against the prior baseline expectations
  - Role: builder
  - Deliverable: parity delta resolved or documented with intent.
  - Verify: all ranking tests green.

- [ ] **2.2** Update `docs/sprint-14-ts-native-retrieval-and-ranking.md` or architecture notes to reflect the final parity rules
  - Role: documenter
  - Deliverable: ranking contract doc update.
  - Verify: docs match implemented scoring behavior.

## TDD / Verification Strategy
- RED: write ranking-parity tests before changing scoring.
- GREEN: implement lexical scoring, then layering of recency/scope/provenance rules.
- REFACTOR: keep scoring composable and easy to audit.
- Recommended checks: targeted ranking tests and a parity comparison run against existing baseline expectations.

## Pseudocode / Design Sketch
```text
score(record, query) =
  lexicalMatchScore
  + recencyBoost
  + stableIdentityBoost
  + scopeMatchBoost
  + provenanceTrustBoost

sortedResults = results.sort(by score desc, then stable tie-breakers)
```

## Risks & Mitigations
- Risk: ranking changes alter caller-visible ordering unexpectedly.
  - Mitigation: constrain changes to documented parity cases and keep tie-breakers stable.
- Risk: parity tests become too fragile.
  - Mitigation: test observable ordering characteristics instead of internal score internals where possible.

## Rollback
- Revert ranking changes if they destabilize read-path correctness or identity semantics.

## Verification Commands
- `pytest tests/unit/ -k ranking`
- `pytest tests/unit/ -k search`
- `pytest tests/unit/ -k parity`
- `npm test -- --runInBand` or the repo-specific TS test command covering `src/` search/ranking behavior

## See Also
- `docs/sprint-18-ts-native-read-path-and-retrieval-baseline.md`
- `docs/sprint-17-ts-native-store-and-stable-identity.md`
- `docs/sprint-14-ts-native-retrieval-and-ranking.md`
- `docs/session-memory-native-architecture.md`

## Definition of Done
- [ ] Native ranking parity is implemented.
- [ ] Search tests pass and are deterministic.
- [ ] Parity regressions are understood and resolved.
- [ ] Docs capture the final ranking rules.
- [ ] Ready for Sprint 20 write-path/store actions.
