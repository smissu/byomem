---
name: file-search-project-registration
description: Register projects explicitly with BYOMem file-search/scanner registry for future safe automation eligibility.
---

# File Search Project Registration

Use this skill when a user asks to register, unregister, audit, or prepare a project for BYOMem file-search/scanner automation.

## Core rules

- Registration is explicit opt-in.
- Do not infer registration from saved memories, existing memory records, `native-store.json`, `byomem-index.sqlite`, `byomem-file-search.sqlite`, or prior file-search usage.
- Do not auto-register a project unless the user requested registration or clearly approved it.
- Manual file-search scan/search/status may mark a project as `seen`, but `seen` is not automation eligibility.
- Only `enabled` projects are eligible for future polling/scanner automation.
- Sprint 37 does not implement polling, watchers, daemons, or background scanning.

## State semantics

- `seen`: BYOMem observed the project through explicit file-search scan/search/status, but the project is not eligible for future automation.
- `enabled`: the project was explicitly registered and is eligible for future polling automation when that feature exists.
- `disabled`: the project was explicitly unregistered; the registry row is retained, but it is not eligible for automation.

## Workflow

1. Confirm the target project path when it is ambiguous.
2. Prefer an absolute/canonical project path.
3. Register only after explicit user approval.
4. Verify with the list command.
5. Report the resulting state exactly.

## Commands

From this repo, use the BYOMem runtime CLI:

```bash
npm run byomem:cli -- file-search-project-register --base-dir <project>
npm run byomem:cli -- file-search-project-list --json
npm run byomem:cli -- file-search-project-unregister --base-dir <project>
```

Expected safe registration flow:

```bash
npm run byomem:cli -- file-search-project-register --base-dir /path/to/project
npm run byomem:cli -- file-search-project-list --json
```

Expected safe unregister flow:

```bash
npm run byomem:cli -- file-search-project-unregister --base-dir /path/to/project
npm run byomem:cli -- file-search-project-list --json
```

## Verification

After registration or unregistration, inspect `file-search-project-list --json` and confirm:

- `base_dir` matches the intended project path.
- `state` is the expected value (`enabled` after registration, `disabled` after unregister).
- The project appears only once.
- Same-basename projects are represented as distinct `project_key` values.

## Guardrails

- Do not claim a project is registered unless CLI verification confirms `state: enabled`.
- Do not treat `seen` as registered.
- Do not delete memories or file-search index rows when unregistering; unregister is a soft-disable registry operation.
- Do not start polling, file watchers, daemons, or background scans as part of registration.
- Report any unexpected CLI error instead of assuming registration succeeded.
