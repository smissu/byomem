# Sprint 7 — byomem Manage

## Goal
Add explicit lifecycle management actions through `byomem_manage` for safe, manual memory maintenance on top of the Sprint 5.2 query-aware retrieval foundation.

## Scope
- Introduce a manage tool for explicit lifecycle actions.
- Support controlled state transitions such as archive, supersede, and delete.
- Keep the action surface manual and conservative.
- Operate on BYOMem-native records using the stable identity introduced in Sprint 5.1, with query-aware retrieval from Sprint 5.2.
- Avoid broader policy automation or agent-driven maintenance.

## Epics
- **E1: Lifecycle action contract**
- **E2: Safe state transitions**
- **E3: Manual management tooling**

## Stories / tasks
- Define the `byomem_manage` request/response shape.
- Allow explicit lifecycle actions on project-scoped memory items.
- Validate transitions against the existing lifecycle model.
- Preserve traceability for state changes where the storage layer supports it.
- Add tests for allowed transitions and blocked invalid actions.
- Keep the tool focused on explicit user intent rather than background curation.

## Dependencies
- Sprint 5.1 BYOMem-native storage, stable identity, and `byomem_store` write workflows.
- Sprint 5.2 query-aware retrieval on the native store.
- Sprint 6 `byomem_recent` for surfacing recently created items during manual cleanup.
- Existing lifecycle states and curation rules from earlier roadmap work.

## Risks
- Lifecycle management can become too policy-heavy if it tries to solve automation too early.
- Destructive actions need careful defaults to avoid accidental data loss.
- An overly broad manage tool could overlap with future agent automation.

## Acceptance / exit criteria
- A user can explicitly manage memory lifecycle through `byomem_manage`.
- Manual actions remain bounded and do not imply background automation.
- Invalid transitions are rejected safely.
- The tool fits the staged rollout without expanding scope into advanced policy design.
- Management operations target the same native records used by Sprint 5.1, Sprint 5.2, and Sprint 6.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 6 — byomem Recent](./sprint-6-byomem-recent.md)
- [Sprint 5.2 — Query-Aware Retrieval on Native Memory Store](./sprint-5.2-query-aware-native-search-ranking.md)
