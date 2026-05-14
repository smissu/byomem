# BYOMem Global Extension Rollout

## Summary

This rollout makes the TS BYOMem extension global for Pi while preventing duplicate loading inside the `byomem` repo.

## Current blocker

Pi only auto-loads extensions from real TS/JS entrypoints such as:
- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`
- `.pi/extensions/*.ts`
- `.pi/extensions/*/index.ts`

There is currently no global BYOMem extension at:
- `~/.pi/agent/extensions/byomem/index.ts`

The repo-local BYOMem extension in this repo is not suitable as a global install as-is because it anchored its runtime base directory to the extension file location.

## Target end state

After rollout:
- the canonical BYOMem TS extension code lives in this repo as shared source
- Pi auto-discovers a global extension at `~/.pi/agent/extensions/byomem/index.ts`
- the `byomem` repo no longer auto-loads its own local BYOMem runtime from `.pi/extensions/byomem/index.ts`
- the `byomem` repo keeps only minimal repo guidance/config and avoids duplicate BYOMem hooks/tools

## File/path changes

### Shared canonical implementation
- add `ts/packages/runtime/src/pi-extension.ts`
  - canonical TS BYOMem extension implementation
  - default runtime base should resolve from the active project/session context, not extension file location

### Global extension install
- add `~/.pi/agent/extensions/byomem/index.ts`
  - thin wrapper that imports the canonical implementation from this repo

### Disable repo-local auto-load
- remove `.pi/extensions/byomem/index.ts`
  - this prevents Pi from auto-loading a second BYOMem runtime in this repo
- keep `.pi/extensions/byomem/README.md` and `.pi/extensions/byomem/SKILL.md`, but update them to explain that the active runtime is global and this folder is no longer the runtime entrypoint

### Repo guidance
- append a short policy note to `AGENTS.md`
  - this repo should use the global BYOMem extension
  - do not keep a second active repo-local BYOMem runtime under `.pi/extensions/`

### Test/reference updates
- update direct test imports that referenced `.pi/extensions/byomem/index.ts`
  - point them to `ts/packages/runtime/src/pi-extension.ts`

## Validation steps

### Global install validation
1. Confirm `~/.pi/agent/extensions/byomem/index.ts` exists.
2. Confirm the file imports the canonical implementation from this repo.
3. Confirm there is no project-local `index.ts` left under `.pi/extensions/byomem/`.

### byomem repo validation
1. Reload Pi in `<HOME>/Documents/byomem`.
2. Confirm there are no duplicate BYOMem extension/tool conflicts.
3. Confirm BYOMem tools/command are available through the global extension.
4. Confirm `/byomem-status` reports a store base directory rooted in the active project, not `~/.pi/agent/extensions/...`.

### cross-project validation
1. Start Pi in another project.
2. Confirm the global BYOMem extension is available there too.
3. Run `byomem-deploy` in that other project and verify it no longer blocks on a missing global BYOMem extension.

## Rollback

If needed, rollback by:
1. removing `~/.pi/agent/extensions/byomem/`
2. restoring `.pi/extensions/byomem/index.ts` in this repo
3. removing the AGENTS note if it no longer matches reality

## Success criteria

- one active BYOMem runtime extension per session
- global BYOMem works in `byomem` and non-`byomem` repos
- no duplicate BYOMem hooks/tools/commands in the `byomem` repo
- `byomem-deploy` can verify a real global extension exists
