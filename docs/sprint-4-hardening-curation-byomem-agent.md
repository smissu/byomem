# Sprint 4 — Hardening, Curation, and byomem-agent

## Goal
Harden the memory system for long-term use and prepare the path to automated curation via `byomem-agent`.

## Scope
- Implement curation workflows for lifecycle transitions.
- Add cleanup and retention policy support.
- Improve auditability and safe deletion behavior.
- Prepare automation hooks for a future `byomem-agent`.

## Epics
- **E1: Curation lifecycle automation**
- **E2: Retention and cleanup**
- **E3: Future agent automation hooks**

## Stories / tasks
- Transition stale memories from `active` to `superseded` or `archived`.
- Mark eligible memories `expired` and remove `deleted` items from serving paths.
- Add curation audit records for state changes.
- Provide a safe manual review path before destructive cleanup.
- Define extension points for `byomem-agent` to manage refresh and policy actions.
- Add regression tests for lifecycle transitions and retention rules.

## Dependencies
- Sprint 1 lifecycle states.
- Sprint 2 retrieval policy behavior.
- Sprint 3 integration feedback from real Pi usage.

## Risks
- Aggressive curation can remove useful context too early.
- Automation may supersede human judgment if policy is too blunt.
- Audit requirements may expand once real usage begins.

## Acceptance / exit criteria
- Lifecycle transitions are enforced consistently.
- Expired and deleted memories do not surface in normal retrieval.
- Curation actions are auditable.
- `byomem-agent` is documented as the next automation layer, even if not fully shipped.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
