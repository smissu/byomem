# Sprint 3 — Pi-Native Integration

## Goal
Integrate byomem into Pi CLI through a first-class `pi-byomem` workflow.

## Scope
- Add Pi-facing integration entrypoints.
- Wire Pi config to the retrieval API.
- Provide a clean UX for lookup and memory selection.
- Document operational use in Pi workflows.

## Epics
- **E1: `pi-byomem` command integration**
- **E2: Config and provider wiring**
- **E3: User workflow and docs**

## Stories / tasks
- Add `pi-byomem` as the Pi-native command or integration layer.
- Map Pi request context to byomem scope inputs.
- Support project-aware defaults derived from the current workspace.
- Surface top matches with compact reasons and source metadata.
- Keep the integration stateless on the byomem side.
- Add usage docs and a minimal troubleshooting guide.

## Dependencies
- Sprint 2 retrieval API and ranking behavior.
- Stable scope model from Sprint 1.

## Risks
- Pi UX can become noisy if retrieval output is too verbose.
- Integration may need command-line and config iteration.
- Workspace detection must not misclassify scope.

## Acceptance / exit criteria
- Pi can call byomem through `pi-byomem`.
- Retrieval honors project and directory scope from the current workspace.
- Users can inspect why a memory was returned.
- Integration docs are published with the sprint deliverable.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Pi memory implementation backlog](./pi-memory-implementation-backlog.md)
