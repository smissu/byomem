# Sprint 11: TS BYOMem Contracts and Parity

## Goal / Objective
Define the TypeScript-native BYOMem contracts, module boundaries, and parity targets so implementation can move off markdown-first assumptions without breaking existing behavior.

## Scope / Workstreams
- Define canonical TS record shapes for memory, provenance, scope, and identity.
- Establish package/module boundaries for native storage, retrieval, and optional projections.
- Map the current markdown-driven behavior to explicit parity targets.
- Identify the minimum compatibility layer needed for existing callers.

## Dependencies
- `docs/pi-memory-roadmap.md`
- `docs/session-memory-native-architecture.md`
- Sprint 8–10 BYOMem and session-memory implementation docs

## Acceptance Criteria
- TS-native contracts are documented and repo-aligned.
- Native storage and retrieval responsibilities are separated from markdown export/projection.
- Parity gaps against the current BYOMem behavior are listed clearly.

## Verification Steps
- Compare the proposed contracts to existing memory record usage in the codebase.
- Confirm each planned module has a clear owner and call surface.
- Validate that markdown is no longer treated as the source of truth.

## Risks / Notes
- Overly broad contracts can slow implementation; keep the first pass minimal.
- Hidden legacy assumptions may still exist in call sites or tests.

## See Also
- [Pi Memory Integration Roadmap](./pi-memory-roadmap.md)
- [Session memory native architecture](./session-memory-native-architecture.md)
- [Sprint 10: Session-Derived Memory End-to-End](./sprint-10-session-derived-memory-end-to-end.md)
