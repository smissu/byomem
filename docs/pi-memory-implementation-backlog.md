# Pi Memory Implementation Backlog

## Overview
This backlog converts the Pi/byomem sprint plan into an execution order for implementation. It focuses on the smallest set of work needed to make `pi-byomem` usable, then expands into hardening and automation.

## Prioritization approach
Priority is based on dependency order and user value:
- **P0** = blocks the MVP or core Pi workflow
- **P1** = needed for stable day-2 usage and operational quality
- **P2** = valuable follow-on work that can wait

## Prioritized epics/features

### 1) Pi-native lookup path
**Priority:** P0
**Why now:** This is the user-facing entrypoint and the main integration goal.
**Includes:**
- `pi-byomem` command/integration layer
- Pi request context mapped to byomem scope inputs
- Project-aware defaults from the current workspace
- Compact top-match output with reasons and source metadata

**Dependencies:**
- Sprint 2 retrieval API and ranking behavior
- Stable scope model from Sprint 1

**Definition of done:**
- Pi can call byomem through `pi-byomem`
- Scope is derived correctly from the active workspace
- Returned memories are explainable and compact

### 2) Config and provider wiring
**Priority:** P0
**Why now:** The command is not usable without config integration and request plumbing.
**Includes:**
- Pi config wiring to retrieval API
- Provider/transport hookup
- Stateless request flow end to end

**Dependencies:**
- Retrieval API contract from Sprint 2
- Integration entrypoint from Epic 1

**Definition of done:**
- Pi config can point at byomem reliably
- Retrieval requests are stateless and repeatable
- Workspace detection does not misclassify scope

### 3) Usage docs and troubleshooting
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

### 4) Curation lifecycle automation
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

### 5) Retention and cleanup
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

### 6) Future agent automation hooks
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
Stop at **Pi-native lookup path + config/provider wiring + minimal docs**. Everything after that is post-MVP unless it is required to unblock basic `pi-byomem` usage.

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

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
