# Pi Memory Implementation Backlog

## Overview
This backlog converts the Pi/byomem sprint plan into an execution order for implementation. It focuses on the smallest set of work needed to make `pi-byomem` usable, then expands into hardening and automation. Sprint 3 delivered the Pi-native integration shell; Sprint 5 was the initial manual store shortcut; Sprint 5.1 supplies the BYOMem-native storage and stable identity foundation, and Sprint 5.2 restores query-aware retrieval quality on top of it.

## Prioritization approach
Priority is based on dependency order and user value:
- **P0** = blocks the MVP or core Pi workflow
- **P1** = needed for stable day-2 usage and operational quality
- **P2** = valuable follow-on work that can wait

## Prioritized epics/features

### 1) Manual store entrypoint
**Priority:** P0
**Why now:** The initial `byomem_store` shortcut is part of the usable integration surface.
**Includes:**
- Manual `byomem_store` write path
- Project-scoped write behavior
- Minimal validation and safety checks

**Dependencies:**
- Sprint 1 scope model and Sprint 3 Pi-native wiring
- Current workspace context and tool registration

**Definition of done:**
- Users can explicitly store a project-scoped memory
- No implicit auto-save behavior is introduced
- The shortcut stays thin and manual

### 2) BYOMem-native storage foundation
**Priority:** P0
**Why now:** This is the new canonical store path for Pi memories and the base for all later memory UX.
**Includes:**
- BYOMem-native write path for `byomem_store`
- Stable `project_id` / `dir_id` identity resolution
- Retrieval reading the same native records written by the store path
- Explicit deferral of legacy Claude-memory migration

**Dependencies:**
- Sprint 1 scope model and Sprint 2 retrieval API
- Sprint 3 Pi-native wiring and current workspace context

**Definition of done:**
- New Pi memories are stored natively in BYOMem
- Writes and retrieval use the same record set
- Stable identity is available for supported project and directory scopes

### 3) Pi-native lookup path
**Priority:** P0
**Why now:** This is the user-facing entrypoint and the main integration goal.
**Includes:**
- `pi-byomem` command/integration layer
- Pi request context mapped to byomem scope inputs
- Project-aware defaults from the current workspace
- Compact top-match output with reasons and source metadata

**Dependencies:**
- Sprint 5.1 native storage and stable identity foundation
- Sprint 2 retrieval API and ranking behavior

**Definition of done:**
- Pi can call byomem through `pi-byomem`
- Scope is derived correctly from the active workspace
- Returned memories are explainable and compact

### 4) Query-aware retrieval on native store
**Priority:** P0
**Why now:** Query-aware retrieval is the core user-facing quality layer on the native corpus.
**Includes:**
- Hybrid full-text + semantic ranking over native records
- Derived index/search over `MemoryRecord` source data
- Stable project/user scope filtering in retrieval

**Dependencies:**
- Sprint 5.1 native storage and stable identity foundation
- Sprint 2 retrieval policy and existing hybrid ranking behavior
- Sprint 3 Pi-native wiring

**Definition of done:**
- Retrieval is query-aware again on top of native records
- Search/index remains derived from the canonical store
- Scope handling stays project/user only

### 5) Config and provider wiring
**Priority:** P1
**Why now:** The command is not usable without config integration and request plumbing.
**Includes:**
- Pi config wiring to retrieval API
- Provider/transport hookup
- Stateless request flow end to end

**Dependencies:**
- Retrieval API contract from Sprint 2
- Integration entrypoint from Epic 1
- Sprint 5.1 native storage foundation for stable read/write semantics

**Definition of done:**
- Pi config can point at byomem reliably
- Retrieval requests are stateless and repeatable
- Workspace detection does not misclassify scope

### 6) Usage docs and troubleshooting
**Priority:** P1
**Why now:** Enables adoption and lowers support friction once the flow exists.
**Includes:**
- Usage docs for Pi workflows
- Minimal troubleshooting guide
- Clear examples for lookup and selection behavior

**Dependencies:**
- Working `pi-byomem` command
- Confirmed config shape

**Definition of done:**
- Docs describe setup, usage, and common failures
- Examples match the implemented workflow

### 7) Curation lifecycle automation
**Priority:** P1
**Why now:** Needed for keeping memories healthy after the MVP ships.
**Includes:**
- `active` → `superseded` / `archived` transitions
- `expired` handling and safe removal from serving paths
- Curation audit records

**Dependencies:**
- Sprint 1 lifecycle states
- Sprint 2 retrieval policy behavior
- Real-world feedback from Sprint 3

**Definition of done:**
- Lifecycle transitions are enforced consistently
- Audit trail exists for state changes
- Non-serving states do not appear in normal retrieval

### 8) Retention and cleanup
**Priority:** P1
**Why now:** Prevents buildup and keeps the store operationally safe.
**Includes:**
- Cleanup policy support
- Safe manual review path before destructive deletion
- Regression tests for retention rules

**Dependencies:**
- Curation lifecycle automation

**Definition of done:**
- Deleted items are removed from serving paths
- Cleanup can be reviewed safely before execution
- Retention rules are tested

### 9) Future agent automation hooks
**Priority:** P2
**Why now:** Useful, but not required for the Pi integration MVP.
**Includes:**
- Extension points for `byomem-agent`
- Refresh/policy action hooks
- Documentation of the next automation layer

**Dependencies:**
- Stable lifecycle and API contracts
- Curation workflow behavior

**Definition of done:**
- Hooks are defined without coupling the MVP to agent automation
- Future automation can be added without redesigning the API

## MVP cutoff line
Stop at **Sprint 5.2 query-aware retrieval + Pi-native lookup path + config/provider wiring + minimal docs**. Everything after that is post-MVP unless it is required to unblock basic `pi-byomem` usage. Sprint 3 remains the integration shell; Sprint 5 is the manual shortcut; Sprint 5.1 supplies the new canonical storage layer; Sprint 5.2 restores query-aware retrieval on top.

## Near-term milestones
- **Milestone 1:** `pi-byomem` works end to end in a local Pi workflow
- **Milestone 2:** Scope resolution is correct for project and directory contexts
- **Milestone 3:** Docs are published with setup and troubleshooting notes
- **Milestone 4:** Lifecycle cleanup and retention are ready for production hardening

## Deferred items
- Global cross-project memory layer
- Advanced automation beyond `byomem-agent` hooks
- Broad UX polish beyond compact match output
- Nonessential ranking experiments and extra metadata surfaces
- Legacy Claude-memory migration for existing records
- The manual Sprint 5 shortcut remains thin and project-scoped, not the long-term canonical store

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
