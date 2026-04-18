# Sprint 13: TS Native Write Path and Migration

## Goal / Objective
Implement the TypeScript-native write path and migrate BYOMem writes so new memory records land durably in the native store by default.

## Scope / Workstreams
- Route BYOMem writes through the native TS persistence layer.
- Preserve provenance, scope, and identity metadata on write.
- Add or update migration logic for any existing markdown-backed records that still need visibility.
- Keep markdown generation optional and non-authoritative.

## Dependencies
- Sprint 11 TS-native contracts and parity definitions.
- Sprint 12 TS-native read path.
- Existing durable storage and identity behaviors from earlier native-memory work.

## Acceptance Criteria
- New BYOMem records are written to native storage durably.
- Written records are retrievable through the native read path.
- Migration behavior is defined for any required legacy carryover.

## Verification Steps
- Write a new record through the TS-native API.
- Confirm persistence survives reload.
- Confirm the record is readable through the native path after restart.
- If migration applies, confirm migrated records are surfaced once and with correct metadata.

## Risks / Notes
- Dual-write or migration complexity can introduce duplication if not bounded.
- Compatibility with older callers may need a temporary shim.

## See Also
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 10: Session-Derived Memory End-to-End](./sprint-10-session-derived-memory-end-to-end.md)
