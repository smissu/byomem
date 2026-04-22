# Sprint 24: SQLite Sidecar Mutator Exposure Fix for Pi Extension Startup

## Objective
Document the targeted fix that restored Pi BYOMem extension startup after the SQLite sidecar refactor split the public reader surface from the internal mutator surface.

## Problem
The BYOMem Pi extension began failing to load with:

- `SQLite sidecar mutator unavailable`

This happened during extension import because `pi-extension.ts` opens the native store eagerly, and `openNativeStore()` requires access to the SQLite sidecar mutator.

## Root Cause
The SQLite sidecar refactor changed the module shape from a combined read/write sidecar to:

- a public reader surface (`SqliteSidecar`)
- a private mutator surface (`SqliteSidecarMutator`)

However, the refactor stopped short of wiring the two back together for the native store:

1. `openSqliteSidecarBundle()` returned `{ sidecar, mutator }`
2. `openSqliteSidecar()` returned only `sidecar`
3. `openNativeStore()` still expected to find an internal mutator on the returned sidecar
4. the mutator was never attached, so startup failed immediately

In short: the ownership boundary was introduced, but the hidden ownership channel from the reader surface back to the native-store owner was not preserved.

## What Changed
### 1. Restored hidden mutator exposure in `sqlite-sidecar.ts`
Added:

- `sqliteSidecarMutatorKey` as a symbol-based internal key
- `getSqliteSidecarMutator(sidecar)` helper

Changed `openSqliteSidecar()` so it now:

- calls `openSqliteSidecarBundle()`
- attaches the mutator to the returned sidecar with `Object.defineProperty(...)`
- keeps the property non-enumerable so the public reader surface remains read-only to normal callers

### 2. Switched `store.ts` to the supported helper lookup
Replaced the dead `__mutator` lookup with `getSqliteSidecarMutator(sidecar)`.

This makes the native store depend on the current internal contract instead of an unattached legacy field.

### 3. Fixed the reader-surface regression test
Updated `sqlite-sidecar.test.ts` to use:

- `sidecar.read(...)`

instead of the invalid:

- `sidecar.sidecar.read(...)`

That keeps the test aligned with the refactored public API shape.

## Why This Fix
This approach preserves the intended architecture:

- public callers get a reader-only sidecar surface
- write access remains restricted to the native store owner path
- the mutator is still hidden from normal enumeration and consumer code
- Pi extension startup works again because `openNativeStore()` can recover the internal mutator

This is the smallest fix that restores behavior without undoing the ownership split.

## Verification
Ran:

- `npm test -- --run ts/packages/runtime/tests/sqlite-sidecar.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts`

Result:

- 2 test files passed
- 25 tests passed

Also verified:

- `pi --continue` reached the normal interactive UI
- the previous extension-load failure did not appear

## Files Changed
- `ts/packages/runtime/src/sqlite-sidecar.ts`
- `ts/packages/runtime/src/store.ts`
- `ts/packages/runtime/tests/sqlite-sidecar.test.ts`
- `docs/sprint-24-sqlite-sidecar-mutator-exposure-fix.md`

## Outcome
Pi can load the BYOMem extension again, and the SQLite sidecar refactor now preserves its hidden native-store write path while keeping the public surface reader-only.
