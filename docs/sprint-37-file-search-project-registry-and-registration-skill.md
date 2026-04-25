# Sprint 37: File Search Project Registry and Registration Skill

## Objective
Add an explicit global file-search project registry so BYOMem can track projects intentionally before future polling automation. The registry distinguishes **seen** projects from **enabled/registered** projects: normal file-search usage may record that a project has been seen, but only explicit registration opts a project into future automated scanning. This sprint also adds a project-local Pi skill that teaches agents how to register projects safely for the file-search/scanner workflow.

## User Rationale
The global file-search DB from Sprint 36 allows many projects to share one physical index. To automate rescans later, BYOMem needs a durable list of projects that are eligible for automation. The registry should not infer automation eligibility from saved memories, because memories and file indexing have different privacy and performance implications. Registration should be explicit, agent-readable, and easy to verify.

## Scope
### In scope
- Add a global file-search project registry persisted with the global file-search runtime data.
- Track project entries with at least:
  - `project_key`
  - canonical `base_dir`
  - display/name metadata
  - `seen` / `enabled` state
  - source (`manual-register`, `manual-scan`, `manual-search`, `manual-status`, etc.)
  - timestamps such as `created_at`, `last_seen_at`, `registered_at`, `updated_at`
  - optional future-ready fields such as `poll_interval_seconds`, `last_scan_at`, `last_error`
- Record **seen** entries from explicit file-search interactions such as scan/search/status without enabling automation.
- Add manual registry CLI commands:
  - `file-search-project-register --base-dir <project>`
  - `file-search-project-unregister --base-dir <project>`
  - `file-search-project-list --json`
- Ensure registration does **not** depend on saved memories, `native-store.json`, `byomem-index.sqlite`, or memory search results.
- Add a project-local skill at `.pi/skills/file-search-project-registration/SKILL.md` with workflow instructions for agents.
- Update docs index/roadmap/runbook with registry behavior and automation boundaries.

### Out of scope
- Polling loop implementation.
- Filesystem event watchers/daemons/background scanning.
- Automatically enabling projects for polling because they have memories or have been searched.
- Cross-project aggregate search UX.
- Import/migration of legacy project-local file-search DBs.
- Changing memory store registration or memory write semantics.

## Investigation Summary
- Sprint 36 moved file-search DB storage to a global runtime DB while preserving per-project `project_key` partitions.
- The scanner remains on-demand per `--base-dir`; there is no durable registry table yet for projects eligible for future automation.
- A polling automation sprint will need an explicit project list. Using projects with saved memories would be surprising and unsafe because memory curation does not imply permission to scan source files.
- Pi skills are discovered from project-local `.pi/skills/<skill-name>/SKILL.md` files when they contain required `name` and `description` frontmatter. The skill name should match the parent directory and use lowercase letters/numbers/hyphens.

## Acceptance Criteria
- [x] **AC37-1:** A global file-search project registry exists and is stored independently of project-local memories.
- [x] **AC37-2:** Registry entries distinguish seen projects from enabled/registered projects.
- [x] **AC37-3:** `file-search-project-register --base-dir <project>` explicitly enables/registers the canonical project path without requiring any saved memories.
- [x] **AC37-4:** `file-search-project-unregister --base-dir <project>` soft-disables the registry entry with `state: disabled` without deleting memories, file-search index rows, or the registry row.
- [x] **AC37-5:** `file-search-project-list --json` returns all registry entries (`seen`, `enabled`, and `disabled`) with project key, base dir, state, source, and timestamps in stable `base_dir ASC` order.
- [x] **AC37-6:** File-search scan/search/status may record projects as `seen`, but must not set `enabled` unless explicit registration is requested.
- [x] **AC37-7:** Memory store/write/search/prune activity, including CLI `store`, `search`, and `prune`, must not create or enable file-search registry entries.
- [x] **AC37-8:** Registry operations are idempotent: re-registering the same absolute resolved path updates timestamps/state instead of duplicating entries; symlink equivalence beyond `resolve(...)` is out of scope.
- [x] **AC37-9:** Registry project keys use the Sprint 36 collision-safe file-search project key helper, so same-basename projects in different parent directories remain distinct.
- [x] **AC37-10:** A project-local skill exists at `.pi/skills/file-search-project-registration/SKILL.md` with valid YAML frontmatter at the top, `name: file-search-project-registration`, a non-empty `description`, and a parent directory matching the skill name.
- [x] **AC37-11:** The skill instructs agents not to infer scanner registration from saved memories or existing DB files, and to verify registration through the CLI list command.
- [x] **AC37-12:** Registry commands do not start polling, watchers, daemons, background scans, or automatic project scans in this sprint.
- [x] **AC37-13:** Existing Sprint 27–36 file-search behavior remains green.
- [x] **AC37-14:** Docs clearly state polling/automation execution is deferred to a future sprint.

## Execution Mode
standard

Rationale: the registry affects shared runtime/CLI surfaces and global DB behavior. Implementation should be serialized after RED tests lock the data model and CLI contract. The project-local skill and docs can be completed after command names/output shape are stable.

## Proposed Registry Contract
The exact table/module names should be locked by RED tests, but the registry should be close to:

```sql
CREATE TABLE IF NOT EXISTS file_search_projects (
  project_key TEXT PRIMARY KEY,
  base_dir TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL, -- seen | enabled | disabled
  source TEXT NOT NULL,
  poll_interval_seconds INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  registered_at TEXT,
  last_scan_at TEXT,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_search_projects_base_dir ON file_search_projects(base_dir);
```

State semantics:
- `seen`: project was observed through explicit file-search scan/search/status, but is not eligible for future polling automation.
- `enabled`: project was explicitly registered and is eligible for future polling automation.
- `disabled`: project was explicitly disabled/unregistered; its index rows are not automatically deleted and the registry row is retained.

Allowed source values for Sprint 37:
- `manual-register`
- `manual-unregister`
- `manual-scan`
- `manual-search`
- `manual-status`

Path canonicalization:
- Store absolute `resolve(baseDir)` paths.
- Deduplicate by the resolved path.
- Symlink target equivalence beyond `resolve(...)` is explicitly out of scope for this sprint.

List contract:
- `file-search-project-list --json` returns all states (`seen`, `enabled`, `disabled`).
- Entries are sorted by `base_dir ASC` for stable CLI output and tests.

## Phase 0 — RED Tests / Contract Locking
- [x] **0.1** Add registry persistence tests in `ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts`.
  - Role: test-engineer
  - Deliverable: failing tests for registry table/module creation, entry shape, canonical path storage, and global DB placement.
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts` fails before implementation.

- [x] **0.2** Add seen vs enabled state transition tests.
  - Role: test-engineer
  - Deliverable: failing tests proving file-search usage records `seen`, explicit register sets `enabled`, unregister sets `disabled`, and re-registering is idempotent.
  - Depends on: 0.1
  - Verify: focused Sprint 37 tests fail before implementation.

- [x] **0.3** Add no-memory-inference tests.
  - Role: test-engineer
  - Deliverable: failing tests proving `openNativeStore().write(...)`, memory `search`, CLI `store`, CLI `search`, CLI `prune`, and existing `native-store.json`/`byomem-index.sqlite`/`byomem-file-search.sqlite` files do not create or enable registry entries.
  - Depends on: 0.1
  - Verify: focused Sprint 37 tests fail before implementation.

- [x] **0.4** Add CLI registry command tests in focused Sprint 37 CLI tests or `ts/packages/runtime/tests/cli.test.ts`.
  - Role: test-engineer
  - Deliverable: failing tests for `file-search-project-register`, soft-disable `file-search-project-unregister`, `file-search-project-list --json` all-state stable ordering, output shape, idempotency, and no polling/scanning side effects.
  - Depends on: 0.1, 0.2
  - Verify: targeted CLI tests fail before implementation.

- [x] **0.5** Add project-local skill validation test or documented verification.
  - Role: test-engineer/documenter
  - Deliverable: test or checklist proving `.pi/skills/file-search-project-registration/SKILL.md` exists, frontmatter is the first block, `name` equals `file-search-project-registration`, `description` is present, and required guardrails/instructions are included.
  - Depends on: none
  - Verify: test/check fails before skill is added.

## Phase 1 — Registry Foundation
- [x] **1.1** Add registry schema and operations.
  - Role: typescript-coder
  - Likely files: new `ts/packages/runtime/src/file-search-project-registry.ts`, `ts/packages/runtime/src/file-search-db.ts` if schema lives with file-search DB.
  - Deliverable: create/list/register/unregister/markSeen operations with canonical path and `resolveFileSearchProjectKey()` integration.
  - Depends on: 0.1, 0.2
  - Verify: Sprint 37 registry tests pass.

- [x] **1.2** Persist registry in the global file-search DB or an adjacent global file-search registry store.
  - Role: typescript-coder
  - Deliverable: registry uses the same global runtime base and does not write project-local files.
  - Depends on: 1.1
  - Verify: tests assert no project-local registry/DB files appear.

- [x] **1.3** Add seen-project recording for file-search scan/search/status.
  - Role: typescript-coder
  - Likely files: `file-search-db.ts`, `file-search-query.ts`, `cli.ts`, registry module.
  - Deliverable: scan/search/status update `last_seen_at` and `source` while preserving `state: seen` unless already enabled/disabled according to contract.
  - Depends on: 1.1
  - Verify: seen vs enabled tests pass.

## Phase 2 — CLI Registry Commands
- [x] **2.1** Add `file-search-project-register` command.
  - Role: typescript-coder
  - Likely file: `ts/packages/runtime/src/cli.ts`.
  - Deliverable: explicit registration command canonicalizes path, sets `enabled`, returns JSON entry.
  - Depends on: Phase 1
  - Verify: CLI register tests pass.

- [x] **2.2** Add `file-search-project-unregister` command.
  - Role: typescript-coder
  - Deliverable: soft-disables registration with `state: disabled` and `source: manual-unregister` without deleting memories, registry rows, or index rows.
  - Depends on: 2.1
  - Verify: CLI unregister tests pass.

- [x] **2.3** Add `file-search-project-list --json` command.
  - Role: typescript-coder
  - Deliverable: lists registry entries with stable JSON output.
  - Depends on: 2.1
  - Verify: CLI list tests pass.

- [x] **2.4** Ensure registry commands do not require embedding providers or memory writes.
  - Role: typescript-coder
  - Deliverable: registry commands operate against global file-search registry only and fail safely on invalid paths.
  - Depends on: 2.1-2.3
  - Verify: CLI tests pass without embedding configuration.

## Phase 3 — Project-Local Skill and Docs
- [x] **3.1** Add `.pi/skills/file-search-project-registration/SKILL.md`.
  - Role: documenter
  - Deliverable: valid Pi skill with required frontmatter and agent workflow.
  - Depends on: command names/output stable.
  - Verify: skill validation/doc test passes; fresh Pi sessions can discover the skill after restart.

- [x] **3.2** Add skill instructions for agents.
  - Role: documenter
  - Required content:
    - registration is explicit;
    - do not infer registration from saved memories, `native-store.json`, `byomem-index.sqlite`, `byomem-file-search.sqlite`, or prior file-search usage;
    - confirm target path when ambiguous;
    - run register/list/unregister commands;
    - report resulting state;
    - polling/watcher automation is out of scope for Sprint 37.
  - Depends on: 3.1
  - Verify: skill content review.

- [x] **3.3** Update docs/runbook/index/roadmap.
  - Role: documenter
  - Files: `docs/README.md`, `docs/pi-memory-roadmap.md`, `docs/semantic-hybrid-document-search-runbook.md`, new sprint doc closeout.
  - Depends on: implementation stable.
  - Verify: docs links resolve and behavior matches implementation.

## Phase 4 — Regression / Review
- [x] **4.1** Run focused Sprint 37 tests.
  - Role: test-engineer
  - Verify:
    ```bash
    npm test -- --run ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts ts/packages/runtime/tests/cli.test.ts
    ```

- [x] **4.2** Run Sprint 27–37 file-search regression.
  - Role: test-engineer
  - Verify:
    ```bash
    npm test -- --run \
      ts/packages/runtime/tests/sprint-27-file-search-db-foundation.test.ts \
      ts/packages/runtime/tests/sprint-28-file-scanner-indexer-mvp.test.ts \
      ts/packages/runtime/tests/sprint-28-file-scanner-gitignore.test.ts \
      ts/packages/runtime/tests/sprint-29-file-search-mvp.test.ts \
      ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts \
      ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts \
      ts/packages/runtime/tests/sprint-32-file-search-semantic-schema.test.ts \
      ts/packages/runtime/tests/sprint-32-file-search-semantic-query.test.ts \
      ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
      ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts \
      ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts \
      ts/packages/runtime/tests/cli.test.ts
    ```

- [x] **4.3** Run full suite/build/diff check.
  - Role: test-engineer
  - Verify:
    ```bash
    npm test -- --run
    npm run build
    git diff --check
    ```

- [x] **4.4** Run independent code review.
  - Role: code-reviewer
  - Deliverable: review registry safety, no-memory-inference behavior, CLI contract, and skill accuracy.

## Risks & Mitigations
- **Risk: surprise automation.** Users may not expect file-search use to opt projects into polling.
  - Mitigation: scan/search/status only create/update `seen`, never `enabled`; polling later uses only `enabled`.

- **Risk: memory/file-search coupling.** Saved memories might be mistaken as registration signals.
  - Mitigation: explicit AC/tests prohibit memory writes/searches/prunes and memory DB file presence from creating/enabling registry entries.

- **Risk: stale paths.** Registered directories may be moved or deleted.
  - Mitigation: store canonical absolute path and future-ready error fields; polling sprint can mark missing paths unhealthy.

- **Risk: project-key changes.** Sprint 36 introduced hash-suffixed file-search project keys.
  - Mitigation: use `resolveFileSearchProjectKey()` consistently in registry operations.

- **Risk: skill drift.** Skill instructions may diverge from CLI behavior.
  - Mitigation: include command names/output expectations in tests/docs and update skill in same sprint.

## Verification
Planned verification after implementation:

```bash
npm test -- --run ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts ts/packages/runtime/tests/cli.test.ts
npm test -- --run ts/packages/runtime/tests/sprint-36-global-file-search-db-decoupling.test.ts ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts
npm test -- --run
npm run build
git diff --check
```

## Implementation Summary
- Added `ts/packages/runtime/src/file-search-project-registry.ts` with registry schema, canonical path identity, list/register/unregister/mark-seen operations, and Sprint 36 collision-safe project keys.
- Stored registry rows in the global file-search DB alongside scanner/index tables.
- Integrated `seen` recording for explicit file-search scan/search/status paths without enabling automation.
- Added CLI commands `file-search-project-register`, `file-search-project-unregister`, and `file-search-project-list --json`; register/unregister require explicit `--base-dir`, list does not, and CLI output uses snake_case registry fields sorted by `base_dir ASC`.
- Added `.pi/skills/file-search-project-registration/SKILL.md` and a narrow `.gitignore` exception so the project-local skill is trackable without exposing other `.pi` runtime files.
- Added a registry-only global DB open path for registry commands so they do not instantiate the file index scheduler/backstop timer.
- Updated the semantic/hybrid runbook with registry commands, state semantics, and no-polling/no-inference boundaries.

## Definition of Done
- [x] Sprint 37 artifact is linked from docs index and roadmap.
- [x] Global file-search project registry exists and is tested.
- [x] Seen vs enabled/disabled state semantics are implemented and documented.
- [x] Register/unregister/list CLI commands are implemented and tested, including explicit `--base-dir` requirements for register/unregister, soft-disable unregister, all-state list output, and no scheduler timer side effects.
- [x] Memory writes/searches/prunes do not create or enable registry entries.
- [x] File-search usage may record seen projects but does not enable automation.
- [x] Project-local Pi skill exists with valid frontmatter and safe registration workflow.
- [x] Docs explain polling/automation is deferred.
- [x] Sprint 27–37 file-search regression passes.
- [x] Full test suite and build pass.
- [x] Independent review signs off.
