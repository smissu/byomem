# Sprint 6 — byomem Recent

## Goal
Add a small, explicit recent/latest retrieval path through `byomem_recent` for quick access to fresh project memory on top of the Sprint 5.2 query-aware retrieval foundation.

## Scope
- Introduce a recent-items tool that returns the newest relevant memories.
- Keep the feature read-only and separate from write flows.
- Reuse the BYOMem-native records and stable identity established in Sprint 5.1, with query-aware retrieval behavior from Sprint 5.2.
- Keep the recent query surface practical and narrowly scoped.

## Epics
- **E1: Recent retrieval contract**
- **E2: Ranking by recency**
- **E3: Pi tool exposure**

## Stories / tasks
- Define the `byomem_recent` tool request/response shape.
- Support a limited result window and simple recency ordering.
- Return recent items for the current project scope by default.
- Reuse existing adapter/search plumbing where possible instead of adding a new retrieval stack.
- Add tests for default recent retrieval and empty-result behavior.
- Keep the tool read-only and independent from any write policy.

## Dependencies
- Sprint 5.1 BYOMem-native storage and stable `project_id` / `dir_id` identity.
- Sprint 5.2 query-aware retrieval on the native store.
- Existing retrieval/indexing behavior and project scope resolution.
- Stable Pi tool registration and lightweight config normalization.

## Risks
- Recency ranking can become ambiguous if it competes with semantic relevance too early.
- A broad recent API could accidentally drift into a generic listing interface.
- Mixing recent and search semantics may complicate the thin integration layer.

## Acceptance / exit criteria
- A user can request recent project memory explicitly via `byomem_recent`.
- Results are ordered by recency and remain read-only.
- The feature stays small, practical, and compatible with the BYOMem-native Pi integration.
- No automatic surfacing beyond the explicit tool call is introduced.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 5.2 — Query-Aware Retrieval on Native Memory Store](./sprint-5.2-query-aware-native-search-ranking.md)
