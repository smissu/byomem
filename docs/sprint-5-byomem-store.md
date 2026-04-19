# Sprint 5 — byomem Store

## Status
- Historical / partially superseded
- Introduced the initial manual `byomem_store` shortcut
- Later memory features should build on Sprint 5.1 for the native storage + stable identity foundation

## Goal
Add explicit, manual, project-scoped writes through `byomem_store` while keeping the integration thin, opt-in, and historically limited in scope.

## Scope
- Introduce a write tool for deliberate user-initiated memory capture.
- Limit writes to the current project scope by default.
- Preserve the existing retrieval flow and avoid auto-save behavior.
- Keep policy and identity handling conservative.

## Epics
- **E1: Manual write tool contract**
- **E2: Project-scoped write path**
- **E3: Minimal validation and safety checks**

## Stories / tasks
- Define the `byomem_store` tool request shape and response contract.
- Accept explicit content, scope hints, and optional tags/metadata for a write.
- Resolve the current project scope from the existing Pi integration context.
- Persist a new memory record with safe defaults and no implicit writes.
- Add minimal validation for empty content, oversized payloads, and malformed scope input.
- Add tests for successful writes and basic failure cases.

## Dependencies
- Existing byomem persistence layer.
- Current Pi extension config and tool registration pattern.
- Prior retrieval and scope model work from earlier sprints.

## Risks
- Writes may overlap with existing memory ingestion paths if the tool contract is too broad.
- Scope resolution could drift beyond project boundaries if not kept explicit.
- Over-validating identity or policy may make the tool harder to use without adding safety.

## Acceptance / exit criteria
- A user can explicitly store a project-scoped memory via `byomem_store`.
- No automatic capture or background save path is introduced.
- Stored items are retrievable through the existing search flow.
- Write behavior remains conservative and bounded to the current project context.

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 5.1 — BYOMem-Native Storage + Stable Identity Foundation](./sprint-5.1-native-storage-stable-identity.md)
