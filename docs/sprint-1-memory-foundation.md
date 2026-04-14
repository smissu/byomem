# Sprint 1 — Memory Foundation

## Goal
Establish the core memory model and storage contracts needed for Pi integration.

## Scope
- Define memory taxonomy: `project`, `dir`, `user`, `agent`.
- Add lifecycle states: `active`, `superseded`, `archived`, `deleted`, `expired`.
- Create stateless retrieval request/response shapes.
- Establish persistence and indexing contracts for memory records.

## Epics
- **E1: Memory schema and metadata**
- **E2: Scope model and lifecycle model**
- **E3: Retrieval contract baseline**

## Stories / tasks
- Define memory record fields: id, scope, source, content, tags, timestamps, lifecycle state.
- Add scope validation and precedence rules for `project`, `dir`, `user`, `agent`.
- Introduce lifecycle transition helpers and default state handling.
- Specify a stateless retrieval API contract with explicit scope and filters.
- Document how `session` and `global` may be added later without breaking the model.

## Dependencies
- Existing byomem persistence/indexing code.
- Agreement on Pi CLI integration boundaries and terminology.

## Risks
- Scope rules become ambiguous if `dir` and `project` overlap.
- Lifecycle states may be over-modeled before retrieval behavior is stable.
- Schema churn could slow later integration work.

## Acceptance / exit criteria
- Memory objects can be created, read, and filtered by scope.
- Lifecycle states are persisted and round-trip correctly.
- Retrieval contract is documented and implementation-ready.
- No Pi-specific behavior is required in this sprint.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
