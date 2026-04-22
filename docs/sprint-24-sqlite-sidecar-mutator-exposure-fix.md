# Sprint 24: SQLite Sidecar Mutator Exposure Closeout

## Objective
Document the final Sprint 24 fix set that both:

- restored Pi BYOMem extension startup, and
- closed the remaining public mutator-exposure gap at the runtime package boundary.

## Problem
After the SQLite sidecar refactor split the reader and mutator concerns, the runtime briefly regressed in two stages:

1. **startup regression**
   - `openNativeStore()` could no longer reach the SQLite sidecar mutator
   - Pi extension startup failed with `SQLite sidecar mutator unavailable`

2. **boundary-hardening gap**
   - restoring startup through a hidden mutator attachment on the public sidecar object fixed correctness
   - but it still left the mutator recoverable from the public module surface, which kept Sprint 24 item `1.3` / `AC-1` only partial

## Final Fix
The final closeout removed the public recovery path instead of hiding it on the public object.

### 1. Introduced an internal-only sidecar implementation module
Added:

- `ts/packages/runtime/src/sqlite-sidecar-internal.ts`

This module now owns:

- the SQLite sidecar bundle factory
- the internal `{ sidecar, mutator }` pairing
- the mutator-facing implementation used by the native store

### 2. Reduced the public `sqlite-sidecar.ts` module to a reader-only wrapper
`ts/packages/runtime/src/sqlite-sidecar.ts` now exposes only the safe reader-facing API:

- `openSqliteSidecar(...)`
- reader-facing types
- embedding-related public constants used by tests/callers

It no longer exports a public mutator accessor or mutator key.

### 3. Switched `store.ts` to the internal bundle path
`ts/packages/runtime/src/store.ts` now consumes the internal sidecar bundle directly from:

- `sqlite-sidecar-internal.ts`

That keeps the native-store write path working without exposing the mutator through the public sidecar module.

### 4. Narrowed the public runtime package surface
`ts/packages/runtime/src/index.ts` no longer re-exports:

- `./store.js`
- `./sqlite-sidecar.js`
- `./write-path.js`
- `./store-actions.js`

Internal runtime files that still need `openNativeStore(...)` now import it directly from `./store.js` instead of from the public root barrel.

### 5. Updated proof tests
`ts/packages/runtime/tests/sqlite-sidecar.test.ts` now proves the public sidecar surface is reader-only, and `runtime-mode.test.ts` now proves the public runtime barrel no longer exposes direct store/sidecar/write-path helpers.

## Why This Fix Closes the Gap
This final shape preserves both correctness and the intended ownership boundary:

- Pi extension startup still works
- supported runtime writes still go through the queue-backed path
- the public `sqlite-sidecar` module is reader-only
- the mutator is no longer recoverable from the public runtime/package surface
- the public runtime root barrel no longer exposes the native store direct-write API

## Verification
Focused verification:

- `npm test -- --run ts/packages/runtime/tests/sqlite-sidecar.test.ts ts/packages/runtime/tests/store.test.ts ts/packages/runtime/tests/queue-runtime.test.ts ts/packages/runtime/tests/runtime-mode.test.ts`

Result:

- 4 test files passed
- 22 tests passed

Broader changed-area verification:

- `npm test -- --run ts/packages/runtime/tests/shared-corpus.test.ts ts/packages/runtime/tests/adapter.test.ts ts/packages/runtime/tests/runtime-mode.test.ts ts/packages/runtime/tests/queue-runtime.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts ts/packages/runtime/tests/session-capture.test.ts ts/packages/runtime/tests/cli.test.ts ts/packages/runtime/tests/adapter-shadow.test.ts ts/packages/runtime/tests/shadow-harness.test.ts ts/packages/runtime/tests/write-path.test.ts ts/packages/runtime/tests/sqlite-sidecar.test.ts ts/packages/runtime/tests/store.test.ts`

Result:

- 12 test files passed
- 54 tests passed

## Files Changed
- `ts/packages/runtime/src/sqlite-sidecar-internal.ts`
- `ts/packages/runtime/src/sqlite-sidecar.ts`
- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/src/index.ts`
- `ts/packages/runtime/src/cli.ts`
- `ts/packages/runtime/src/pi-extension.ts`
- `ts/packages/runtime/tests/sqlite-sidecar.test.ts`
- `ts/packages/runtime/tests/runtime-mode.test.ts`
- `docs/sprint-24-sqlite-sidecar-mutator-exposure-fix.md`

## Outcome
Sprint 24's remaining SQLite mutator-exposure blocker is closed for the supported runtime and public runtime package surface. Pi still loads the BYOMem extension, supported writes remain queue-backed, and the mutator path is now internal-only to the native-store sidecar implementation.