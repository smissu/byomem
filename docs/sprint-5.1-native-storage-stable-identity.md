# Sprint 5.1 — BYOMem-Native Storage + Stable Identity Foundation

## Goal
Establish BYOMem-native storage as the canonical store for new Pi memories and introduce a stable identity foundation that can support `project_id` / `dir_id` now and remain extensible later.

## Scope
- Make BYOMem-native storage the canonical store for new Pi memories.
- Establish stable identity for Pi memory records, starting with project/user coverage where needed and keeping future `project_id` / `dir_id` extensibility visible.
- Update `byomem_store` to write native records.
- Ensure retrieval reads the same native records.
- Defer old memory migration to a later effort.
- Keep the earlier Claude-memory shortcut clearly superseded for new work.

## Epics
- **E1: Native storage write path**
- **E2: Stable identity foundation**
- **E3: Native retrieval parity**
- **E4: Deferred legacy migration**

## Stories / tasks
- Define the native memory record shape used for Pi writes.
- Resolve stable identity values from the current Pi context with room for `project_id` / `dir_id` expansion.
- Update `byomem_store` to persist directly to BYOMem-native storage.
- Make retrieval read from the same native records written by the store path.
- Add validation for missing identity, malformed scope, and empty content.
- Add tests covering write/read parity and identity stability.
- Document that migration from older Claude project memory is deferred.

## Dependencies
- Existing BYOMem persistence layer and record schema support.
- Stable Pi workspace/context resolution for project and directory identity.
- Sprint 2 retrieval policy and Sprint 3 Pi-native wiring.
- Sprint 5 manual `byomem_store` flow as the integration surface to update.

## Risks
- Identity instability could split memories across multiple records or scopes.
- Partial migration assumptions could leak into the new store path if migration is not clearly deferred.
- Compatibility pressure from the earlier shortcut path could weaken the canonical store.

## Acceptance / exit criteria
- New Pi memories are written to BYOMem-native storage by default.
- `byomem_store` and retrieval operate on the same native record set.
- Stable identity is available for the supported Pi scopes, with `project_id` / `dir_id` extensibility preserved.
- The doc set clearly marks legacy Claude-memory migration as deferred.
- The earlier thin-store shortcut is no longer the forward path for new work.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
- [Sprint 5 — byomem Store](./sprint-5-byomem-store.md)
- [Sprint 6 — byomem Recent](./sprint-6-byomem-recent.md)
- [Sprint 7 — byomem Manage](./sprint-7-byomem-manage.md)