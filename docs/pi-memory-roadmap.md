# Pi Memory Integration Roadmap

## Purpose
Integrate **byomem** into Pi CLI as a long-term memory layer with scope-aware retrieval, stateless APIs, and a clear curation lifecycle.

This roadmap is part of the sprint planning package. The epics, stories, and tasks below are intentionally detailed enough to be scheduled, estimated, and executed across multiple sprints.

## Memory taxonomy
- **project**: memories specific to one repository or workspace
- **dir**: memories scoped to a subdirectory or work area inside a project
- **user**: reusable preferences, facts, and workflows tied to the user
- **agent**: agent-local operational memory and working assumptions
- **session**: ephemeral context retained only for a run or short horizon
- **global**: optional future layer for cross-project shared knowledge

## Curation lifecycle
Memories move through a simple state model:
- **active**: eligible for retrieval
- **superseded**: replaced by a newer memory but kept for traceability
- **archived**: retained, low priority, usually not returned by default
- **deleted**: removed from serving and from most storage paths
- **expired**: aged out by policy and eligible for cleanup

## Product shape
- **Stateless retrieval API**: clients send query + scope + filters; the service returns ranked memory candidates without server-side conversational state.
- **Scope-aware retrieval**: retrieval must respect `project`, `dir`, `user`, and `agent` scopes, with `session` and `global` treated as limited or future extensions.
- **Pi-native integration**: the first-class entrypoint should be `pi-byomem`.
- **Manual store + native foundation**: Sprint 5 introduced the initial `byomem_store` shortcut, Sprint 5.1 establishes BYOMem-native storage with stable identity, and Sprint 5.2 restores query-aware retrieval quality on top of native records. Markdown/MEMORY.md paths remain optional compatibility/export surfaces, not the source of truth.
- **Explicit write and lifecycle tools**: `byomem_store`, `byomem_recent`, and `byomem_manage` should stay manual, scoped, and conservative.
- **Future automation**: a `byomem-agent` can later own curation, refresh, and policy-driven maintenance.
- **Legacy shortcut superseded**: the earlier Claude-memory shortcut is no longer the forward path for new work; migration of old memories is deferred and intentionally bounded to compatibility/documentation cleanup, not a bulk migration program.

## Roadmap epics
1. **Memory foundation**
   - schema, scope model, lifecycle states, indexing contracts
2. **Retrieval policy MVP**
   - stateless search API, scoring, filters, scope precedence, traceability
3. **Pi-native integration**
   - `pi-byomem` command, config wiring, workflow integration, docs
4. **Curation and hardening**
   - lifecycle transitions, garbage collection, auditability, future `byomem-agent`
5. **Manual store entrypoint**
   - explicit `byomem_store`, project-scoped, thin/manual shortcut
5.1. **BYOMem-native storage foundation**
   - canonical native writes, stable identity, deferred legacy migration
5.2. **Query-aware retrieval on native store**
   - hybrid search/ranking, derived index, project/user retrieval quality
6. **Explicit writes and lifecycle controls**
   - recent/latest retrieval, explicit manage actions

## Sprint sequence
- [Sprint 1] sprint-1-memory-foundation.md
- [Sprint 2] sprint-2-retrieval-policy-mvp.md
- [Sprint 3] sprint-3-pi-native-integration.md
- [Sprint 4] sprint-4-hardening-curation-byomem-agent.md
- [Sprint 5] sprint-5-byomem-store.md — manual store shortcut
- [Sprint 5.1] sprint-5.1-native-storage-stable-identity.md — native storage + stable identity foundation
- [Sprint 5.2] sprint-5.2-query-aware-native-search-ranking.md — query-aware retrieval on the native store
- [Sprint 6] sprint-6-byomem-recent.md — recent retrieval on the native + query-aware foundation
- [Sprint 7] sprint-7-byomem-manage.md — lifecycle management on the native foundation
- [Sprint 27] sprint-27-global-file-search-db-foundation.md — file-search DB foundation
- [Sprint 28] sprint-28-file-scanner-indexer-mvp.md — scanner/indexer MVP
- [Sprint 29] sprint-29-file-search-mvp.md — file search MVP
- [Sprint 30] sprint-30-file-index-scheduler-and-hardening.md — scheduler/freshness/hardening
- [Sprint 31] sprint-31-file-search-refinement-and-cleanup.md — refinement and cleanup
- [Sprint 32] sprint-32-semantic-hybrid-document-search.md — semantic/hybrid document search
- [Sprint 33] sprint-33-file-search-scanner-status-progress.md — scanner status/progress
- [Sprint 34] sprint-34-file-search-scan-command.md — explicit file-search scan command
- [Sprint 35] sprint-35-file-search-cli-result-controls.md — file-search CLI result limit controls
- [Sprint 36] sprint-36-global-file-search-db-decoupling.md — decouple global file-search DB storage from scanned project roots
- [Sprint 37] sprint-37-file-search-project-registry-and-registration-skill.md — explicit file-search project registry and agent registration skill


## Cross-sprint dependencies
- Scope model and lifecycle enums must be defined before retrieval policy work
- Retrieval policy must exist before Pi-native wiring can depend on it
- Curation jobs and agent automation should not ship before the lifecycle and API contracts are stable
- Sprint 5 provides the original manual store shortcut; Sprint 5.1 must land the BYOMem-native storage and stable identity foundation before Sprint 5.2 restores query-aware retrieval quality on top of it
- Manual recent and lifecycle tools should build on Sprint 5.2, not on the earlier Claude-memory shortcut

## Success criteria for the program
- Pi can query byomem through a stateless API using explicit scope inputs
- Memory results are filtered and ranked consistently by scope and lifecycle
- `pi-byomem` is usable for day-to-day memory lookup in Pi workflows
- Users can explicitly store, recall recent items, and manage lifecycle without auto-save behavior
- New memories are written and read from BYOMem-native storage using stable identity after Sprint 5.1, and query-aware retrieval is restored in Sprint 5.2
- Curation rules keep the store clean without hiding traceable history
- `byomem-agent` is feasible as a follow-on automation layer
- Old memory migration remains a deferred, separate effort

## See also
- [Docs index](./README.md)
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 13: TS Native Write Path and Migration](./sprint-13-ts-native-write-path-and-migration.md)
- [Sprint 14: TS Native Retrieval and Ranking](./sprint-14-ts-native-retrieval-and-ranking.md)
- [Sprint 15: TS Doc Cleanup and Legacy Retirement](./sprint-15-ts-doc-cleanup-and-legacy-retirement.md)
- [Sprint 16: TS Runtime Foundation and Core Contracts](./sprint-16-ts-runtime-foundation-and-core-contracts.md) — starts the actual TS runtime foundation; Python remains the default runtime for now.
- [Sprint 17: TS Native Store and Stable Identity](./sprint-17-ts-native-store-and-stable-identity.md) — native store and stable identity.
- [Sprint 18: TS Native Read Path and Retrieval Baseline](./sprint-18-ts-native-read-path-and-retrieval-baseline.md) — native read path and retrieval baseline.
- [Sprint 19: TS Native Search and Ranking Baseline](./sprint-19-ts-native-search-and-ranking-baseline.md) — native search and ranking baseline.
- [Sprint 20: TS Native Write Path and Adapter Store Actions](./sprint-20-ts-native-write-path-and-adapter-store-actions.md) — native write path and adapter store actions.
- [Sprint 21: TS Session Capture and Queue Runtime Migration](./sprint-21-ts-session-capture-and-queue-runtime-migration.md) — session capture and queue runtime migration.
- [Sprint 22: TS Adapter Integration and Shadow Validation](./sprint-22-ts-adapter-integration-and-shadow-validation.md) — adapter integration and shadow validation.
- [Sprint 23: TS Runtime Cutover, Legacy Retirement, and Documentation Closure](./sprint-23-ts-runtime-cutover-legacy-retirement-and-documentation-closure.md) — completed TS-native cutover, runtime default, and documentation closure.
- Sprint 23 is the completed state: TS-native is the sole active/default runtime path, and Python is only an explicit disabled-by-default compatibility escape hatch or offline/dev-only surface.
- [Pi memory first implementation tranche](./pi-memory-first-implementation-tranche.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
