# Sprint 13: TS Native Write Path and Migration

## Goal / Objective
Implement the TypeScript-native write path and migrate BYOMem writes so new memory records land durably in the native store by default. Sprint 13 is complete for the intended scope: the native write path is authoritative and write metadata is preserved on write.

## Scope / Workstreams
- Route BYOMem writes through the native TS persistence layer.
- Preserve provenance, scope, identity, and source metadata on write.
- Keep markdown generation optional and non-authoritative.
- Bound migration to policy and adapter seams rather than bulk backfill.

## Dependencies
- Sprint 11 TS-native contracts and parity definitions.
- Sprint 12 TS-native read path.
- Existing durable storage and identity behaviors from earlier native-memory work.

## Exit Criteria / Results
- New BYOMem records are written to native storage durably.
- Written records are retrievable through the native read path.
- Write metadata contracts remain intact, including provenance, scope, identity, source kind, and source ref where present.
- Markdown is optional and non-authoritative on write.
- Migration is bounded to policy + adapter seam behavior; no bulk backfill job is required for the intended scope.

## Verification Commands
- `pytest -q tests/unit/test_pi_adapter.py::test_pi_adapter_project_store_and_ranked_read_round_trip tests/unit/test_pi_adapter.py::test_pi_adapter_user_scope_store_and_read_round_trip tests/unit/test_pi_adapter.py::test_pi_adapter_does_not_depend_on_claude_memory_md`
- `pytest -q tests/unit/test_pi_adapter.py::test_pi_adapter_session_capture_can_skip_markdown_writes tests/unit/test_pi_adapter.py::test_pi_adapter_session_capture_is_idempotent_in_native_store`

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
