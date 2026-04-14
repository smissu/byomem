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
- **Future automation**: a `byomem-agent` can later own curation, refresh, and policy-driven maintenance.

## Roadmap epics
1. **Memory foundation**
   - schema, scope model, lifecycle states, indexing contracts
2. **Retrieval policy MVP**
   - stateless search API, scoring, filters, scope precedence, traceability
3. **Pi-native integration**
   - `pi-byomem` command, config wiring, workflow integration, docs
4. **Curation and hardening**
   - lifecycle transitions, garbage collection, auditability, future `byomem-agent`

## Sprint sequence
- [Sprint 1] sprint-1-memory-foundation.md
- [Sprint 2] sprint-2-retrieval-policy-mvp.md
- [Sprint 3] sprint-3-pi-native-integration.md
- [Sprint 4] sprint-4-hardening-curation-byomem-agent.md

## See also
- [Docs index](./README.md)
- [Pi memory first implementation tranche](./pi-memory-first-implementation-tranche.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)

## Cross-sprint dependencies
- Scope model and lifecycle enums must be defined before retrieval policy work
- Retrieval policy must exist before Pi-native wiring can depend on it
- Curation jobs and agent automation should not ship before the lifecycle and API contracts are stable

## Success criteria for the program
- Pi can query byomem through a stateless API using explicit scope inputs
- Memory results are filtered and ranked consistently by scope and lifecycle
- `pi-byomem` is usable for day-to-day memory lookup in Pi workflows
- Curation rules keep the store clean without hiding traceable history
- `byomem-agent` is feasible as a follow-on automation layer

## See also
- [Docs index](./README.md)
- [Pi memory first implementation tranche](./pi-memory-first-implementation-tranche.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
