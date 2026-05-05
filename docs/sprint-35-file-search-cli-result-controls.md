# Sprint 35: File Search CLI Result Controls

## Objective
Add a small, stable result-control option to the BYOMem `file-search` CLI so users can bound output size explicitly. This sprint introduces `--limit` for file-search while preserving default behavior and existing BM25/semantic/hybrid modes.

## Scope
### In scope
- Parse `--limit <positive-integer>` for the `file-search` command.
- Pass the parsed limit to the existing file-search query path.
- Keep the default limit at 10 when no limit is provided.
- Fail closed with a JSON CLI error for invalid limits.
- Add CLI regression coverage for bounded results and invalid values.
- Document the option in the sprint artifact and runbook.

### Out of scope
- Pagination/cursors.
- Changing ranking or query semantics.
- Changing memory-store `search` command limits.
- New output formats.

## Investigation Summary
- The runtime CLI already accepts file-search `--mode` and hard-coded result limit `10` in `searchFileIndex(...)` calls.
- The lower-level file-search query accepts a limit, so this sprint only needs CLI parsing/validation and tests.
- This can be implemented independently of scanner internals and Sprint 34's explicit scan command.

## Acceptance Criteria
- [x] AC35-1: `file-search --limit 1` returns at most one result when more matches exist.
- [x] AC35-2: Omitting `--limit` preserves the existing default limit of 10.
- [x] AC35-3: Invalid values such as `0`, negative numbers, non-integers, or non-numeric input fail with JSON error `--limit must be a positive integer`.
- [x] AC35-4: `--limit` works with existing `bm25`, `semantic`, and `hybrid` mode validation without changing ranking behavior.
- [x] AC35-5: Existing Sprint 33/34 CLI behavior remains green.

## Execution Mode
standard

Rationale: this is a small CLI parsing and test change in shared `cli.ts`, so a serialized implementation is safer than parallel edits.

## Phases & Tasks
### Phase 0 — RED Tests / Contract Locking
- [x] **0.1** Add failing bounded-output CLI test in `ts/packages/runtime/tests/cli.test.ts`.
  - Role: test-engineer
  - Deliverable: test proves `--limit 1` bounds output.
  - Verify: focused CLI test fails before limit parsing is implemented.
- [x] **0.2** Add failing invalid-limit CLI test.
  - Role: test-engineer
  - Deliverable: JSON error assertion for invalid limit values.
  - Verify: focused CLI test fails before validation is implemented.

### Phase 1 — CLI Implementation
- [x] **1.1** Parse `--limit` in CLI args.
  - Role: typescript-coder
  - Verify: invalid-limit test reaches file-search branch.
- [x] **1.2** Validate positive integer and pass it to `searchFileIndex(...)`.
  - Role: typescript-coder
  - Verify: bounded-output and invalid-limit tests pass.

### Phase 2 — Docs / Regression
- [x] **2.1** Update docs index, roadmap, and runbook with `--limit` usage.
  - Role: documenter
  - Verify: examples match implemented CLI behavior.
- [x] **2.2** Run focused Sprint 33–35 CLI regression.
  - Role: test-engineer
  - Verify: `npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`.

## Verification
- `npm test -- --run ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts` — passed, 2 files / 23 tests.

## Definition of Done
- [x] File-search limit control is implemented and test-covered.
- [x] Invalid values fail closed with JSON errors.
- [x] Default behavior remains unchanged.
- [x] Sprint docs and roadmap/index links are updated.
