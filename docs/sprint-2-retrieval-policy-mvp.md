# Sprint 2 — Retrieval Policy MVP

## Goal
Ship a stateless retrieval service that returns the right memories for a given scope and query.

## Scope
- Implement query-time filtering by scope and lifecycle.
- Add ranking rules for relevant, active memories.
- Expose a stateless retrieval API.
- Add traceable explainability fields for debugging and tuning.

## Epics
- **E1: Retrieval API**
- **E2: Scope-aware ranking**
- **E3: Policy and observability**

## Stories / tasks
- Build `retrieve(query, scope, filters)` as a stateless operation.
- Enforce lifecycle defaults so `active` results are preferred.
- Exclude `deleted` memories and normally exclude `expired` memories.
- Rank by scope proximity: `dir` > `project` > `user` > `agent` where appropriate.
- Return reasons/metadata for why a memory matched.
- Add basic tests for scope isolation and lifecycle filtering.

## Dependencies
- Sprint 1 memory schema and lifecycle model.
- Agreement on scoring and tie-breaking rules.

## Risks
- Over-retrieval from broad `user` scope can drown out project context.
- Under-retrieval if scope filters are too strict.
- Stateless API may still need careful pagination and caching decisions.

## Acceptance / exit criteria
- Retrieval works with explicit scope inputs and no server session state.
- Scope and lifecycle filters behave predictably in tests.
- Results include enough metadata for debugging and tuning.
- API is stable enough for Pi-native integration work.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 3 — Pi-Native Integration](./sprint-3-pi-native-integration.md)
