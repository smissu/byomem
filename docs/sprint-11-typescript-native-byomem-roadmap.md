# Sprint 11: TypeScript-Native BYOMem Roadmap

## Sprint goal
Move the BYOMem implementation and sprint docs toward a TypeScript-native, implementation-ready path that stays aligned with the repo's modern sprint-planning format and the native-first memory architecture.

## Status
Sprint 11 is now documented as complete for the current parity slice: normalized fixtures/replays exist for store, search, session-capture checkpoint, and session-capture flush, with markdown treated as non-authoritative and native-first behavior as the baseline.

## Sprint sequence
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 13: TS Native Write Path and Migration](./sprint-13-ts-native-write-path-and-migration.md)
- [Sprint 14: TS Native Retrieval and Ranking](./sprint-14-ts-native-retrieval-and-ranking.md)
- [Sprint 15: TS Doc Cleanup and Legacy Retirement](./sprint-15-ts-doc-cleanup-and-legacy-retirement.md)

## Workstreams / stories

### 1) TypeScript-native architecture and module boundaries
#### Goal / Objective
Define the TS-native BYOMem shape so implementation work lands in explicit, repo-friendly modules instead of ad hoc markdown-driven behavior.

#### Scope / Workstreams
- Identify the canonical TypeScript entrypoints for BYOMem storage, retrieval, and provenance handling.
- Separate native record persistence from optional markdown export/projection.
- Document the minimal package/module boundaries needed for implementation.

#### Dependencies
- `pi-memory-roadmap.md` for the broader BYOMem architecture and scope model.
- `session-memory-native-architecture` for native-first storage expectations.
- Existing Sprint 8–10 implementation patterns for native-first verification style.

#### Acceptance Criteria
- A clear TS-native implementation path is defined for storage, retrieval, and provenance.
- Markdown is explicitly described as optional, not the source of truth.
- The module boundary assumptions are concrete enough for implementation tickets.

#### Verification Steps
- Review the roadmap against current native storage/retrieval code paths.
- Confirm the proposed modules map cleanly to existing repo structure.
- Check that no step depends on markdown as the primary memory source.

#### Risks / Notes
- Overfitting the doc to current internals may make later refactors harder.
- Hidden legacy paths may still influence the effective runtime behavior.

### 2) Durable native storage and retrieval for TypeScript-native BYOMem
#### Goal / Objective
Ensure TS-native BYOMem writes land durably in the native store and can be read back through the native retrieval path.

#### Scope / Workstreams
- Define the durable write path for TS-native memory records.
- Standardize record identity, provenance, and scope metadata.
- Confirm the read path uses native DB/API access rather than markdown discovery.

#### Dependencies
- Sprint 10 session-derived memory end-to-end work.
- Native storage/stable identity work from Sprint 5.1 and query-aware retrieval from Sprint 5.2.
- Any store/index lifecycle behavior required for durable reads after reload.

#### Acceptance Criteria
- TS-native records are durably persisted.
- Records survive reload and remain retrievable.
- Retrieval works through the native BYOMem path without requiring markdown lookup.

#### Verification Steps
- Write a known record through the TS-native path.
- Reload the store and confirm the record persists.
- Query the native retrieval path and confirm the same record is returned.

#### Risks / Notes
- Write success without durable persistence can look like a pass during shallow verification.
- Index/search lag can obscure whether native storage is actually correct.

### 3) Repo doc alignment and sprint-format normalization
#### Goal / Objective
Update sprint docs so they consistently use the repo's implementation-ready format and are easier to execute from.

#### Scope / Workstreams
- Bring the TypeScript-native roadmap into the same structure used by Sprint 8–10.
- Keep sections concise: goal/objective, scope/workstreams, dependencies, acceptance criteria, verification steps, risks/notes, see also.
- Cross-link related roadmap and architecture docs.

#### Dependencies
- `docs/sprint-10-session-derived-memory-end-to-end.md` as the closest format reference.
- `docs/pi-memory-roadmap.md` for cross-sprint context.

#### Acceptance Criteria
- The roadmap is written in a consistent sprint-planning format.
- A reader can quickly identify the goal, scope, dependencies, verification, and risks.
- Relevant related docs are linked in a brief See Also section.

#### Verification Steps
- Compare the structure against Sprint 10 and confirm the section layout matches the modern format.
- Check that links point to the intended roadmap and architecture docs.

#### Risks / Notes
- Keeping the doc concise may omit some implementation nuance; prefer link-outs over long prose.
- Documentation drift may recur unless later sprint docs follow the same template.

## Cross-sprint dependencies
- Native storage contracts should be stable before deeper retrieval or automation changes.
- Verification must stay native-first so markdown remains a projection/export path only.
- Sprint docs should remain aligned with the implementation order to avoid reintroducing markdown-centric assumptions.

## Acceptance criteria for the sprint
- The roadmap is repo-ready and follows the modern sprint-planning style.
- The document clearly describes the TypeScript-native BYOMem implementation direction.
- Related architecture and sprint docs are linked for follow-on planning.

## Verification steps
1. Compare this roadmap to Sprint 10 for format consistency.
2. Confirm the doc includes goal/objective, scope/workstreams, dependencies, acceptance criteria, verification steps, risks/notes, and see also.
3. Verify links to the relevant existing BYOMem roadmap and architecture docs.

## Risks / Notes
- If later sprint scope changes, this roadmap should be updated to keep the implementation sequence truthful.
- This doc is intentionally concise; detailed tasks belong in the sprint execution docs.

## See Also
- [Pi Memory Integration Roadmap](./pi-memory-roadmap.md)
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 13: TS Native Write Path and Migration](./sprint-13-ts-native-write-path-and-migration.md)
- [Sprint 14: TS Native Retrieval and Ranking](./sprint-14-ts-native-retrieval-and-ranking.md)
- [Sprint 15: TS Doc Cleanup and Legacy Retirement](./sprint-15-ts-doc-cleanup-and-legacy-retirement.md)
- [Session memory native architecture](./session-memory-native-architecture.md)
