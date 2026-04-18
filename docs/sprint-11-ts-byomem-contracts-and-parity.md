# Sprint 11: TS BYOMem Contracts and Parity

## Goal / Objective
Close the TypeScript-native BYOMem parity slice by documenting the native-first contracts and the verified behavior baseline against current Python-backed behavior.

## Scope / Workstreams
- Define canonical TS record shapes for memory, provenance, scope, and identity.
- Establish package/module boundaries for native storage, retrieval, and optional projections.
- Map current markdown-driven behavior to explicit parity targets.
- Capture the minimum compatibility layer needed for existing callers.

## Dependencies
- `docs/pi-memory-roadmap.md`
- `docs/session-memory-native-architecture.md`
- Sprint 8–10 BYOMem and session-memory implementation docs
- Normalized parity fixtures/replays for store, search, session_capture checkpoint, and session_capture flush

## Exit Criteria / Results
- Normalized golden fixtures are established against the current Python-backed baseline.
- Store, search, session_capture checkpoint, and session_capture flush replay with matching normalized outputs.
- Retrieval-after-flush is proven by replaying the flushed/native-write session-capture path and confirming the record is still retrievable.
- Replay is idempotent: rerunning the same normalized fixture set produces the same normalized results.
- The live Pi v3 transcript parser regression is covered for the remaining likely variant, including native write/session-capture shapes that rely on top-level `id` / `parentId` and mixed list content.
- Markdown remains non-authoritative; native-first behavior is the baseline contract, with markdown treated as a projection/export path only.

## Verification Commands
- `python -m pytest tests/unit/test_parity_fixtures.py -m parity -q`
- `pytest -q tests/unit/test_parser.py`

## Risks / Notes
- Overly broad contracts can slow later implementation; keep follow-on work minimal.
- Hidden legacy assumptions may still exist in call sites or tests.

## See Also
- [Pi Memory Integration Roadmap](./pi-memory-roadmap.md)
- [Session memory native architecture](./session-memory-native-architecture.md)
- [Sprint 10: Session-Derived Memory End-to-End](./sprint-10-session-derived-memory-end-to-end.md)
- [Verification Notes](./verification/README.md)
