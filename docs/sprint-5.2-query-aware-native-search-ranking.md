# Sprint 5.2 — Query-Aware Retrieval on Native Memory Store

## Goal
Restore BYOMem's query-aware retrieval quality on top of the Sprint 5.1 native canonical store, using the existing hybrid search approach as the retrieval layer over native records.

## Scope
- Reconnect BYOMem's hybrid query-aware search behavior to the native store.
- Use full-text + semantic ranking on top of native `MemoryRecord` data.
- Keep native records as the source of truth and treat index/search as derived.
- Support only `project` and `user` operationally in this slice.
- Preserve stable `scope` / `scope_id` identity end to end.
- Make Pi retrieval query-aware again without reopening old shortcut paths.
- Defer `dir` / `agent`, old memory migration, recent/manage, and broad ranking redesign.

## Epics
- **E1: Derived query index for native records**
- **E2: Hybrid ranking over project/user scopes**
- **E3: Pi retrieval integration on the native store**

## Stories / tasks
- Build or adapt the native-search index/read path from `MemoryRecord` records.
- Reconnect lexical/full-text matching and semantic ranking over native records.
- Keep score computation and candidate selection derived from the native store.
- Preserve stable `scope` / `scope_id` filtering for project and user queries.
- Update the Pi adapter retrieval path to use query-aware search results from native storage.
- Add tests for query-aware ranking, scope filtering, and stable identity behavior.
- Confirm the canonical flow does not depend on Claude `MEMORY.md`.

## Dependencies
- Sprint 5.1 native storage + stable identity foundation.
- Existing retrieval policy and hybrid search behavior from earlier sprints.
- Pi-native wiring and request shape from Sprint 3.
- Native records produced by `byomem_store` as the source corpus.

## Risks
- Reintroducing query-aware ranking too broadly could blur the canonical/native boundary.
- A search/index layer that mutates the source of truth would complicate the store model.
- Scope drift could reintroduce dir/agent assumptions before they are ready.
- Ranking changes may need careful tuning to avoid regressions in compact Pi output.

## Acceptance / exit criteria
- Pi retrieval is query-aware again on top of the native store.
- Query results come from native `MemoryRecord` data and remain scope-safe for project/user.
- Full-text plus semantic ranking is restored in a derived search layer.
- Stable `scope` / `scope_id` contracts remain intact.
- Claude-memory shortcuts remain non-canonical and migration stays deferred.
- `dir` / `agent`, recent/manage, and broader ranking redesign remain out of scope.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
- [Sprint 5.1 — BYOMem-Native Storage + Stable Identity Foundation](./sprint-5.1-native-storage-stable-identity.md)
- [Sprint 6 — byomem Recent](./sprint-6-byomem-recent.md)
- [Sprint 7 — byomem Manage](./sprint-7-byomem-manage.md)