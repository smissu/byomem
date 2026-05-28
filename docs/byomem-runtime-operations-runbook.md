# BYOMem Runtime Operations Runbook

This runbook covers the non-destructive runtime observability surfaces added for BYOMem operations.

## Commands

Use the existing runtime CLI binary:

```bash
npm run byomem:cli -- status --base-dir /path/to/runtime-or-project
npm run byomem:cli -- cleanup --base-dir /path/to/runtime
npm run byomem:cli -- stop --base-dir /path/to/runtime
```

`status`, `cleanup`, and `stop` are JSON-first commands.

## Status

`status` is stat-only. It reports:

- runtime version
- project and runtime base paths
- memory, file-search, and graph artifact paths
- artifact existence, size, and mtime
- runtime-state MCP process inventory summary

It must not open SQLite handles, create DBs, scan files, update graphs, or inspect host process tables.

## Runtime State

BYOMem MCP entrypoints write one JSON record per live process under:

```text
<runtime-base>/runtime-state/processes/
```

Each record includes:

- role
- server name
- pid and ppid
- argv
- cwd
- entrypoint
- runtime version
- startedAt
- lastHeartbeatAt

MCP entrypoints remove their own record on normal process exit, SIGINT, SIGTERM, or startup failure. A process only removes a record when the id, pid, server name, entrypoint, and startedAt metadata still match.

## Cleanup And Stop Dry Run

`cleanup` and `stop` are dry-run only in this implementation. They classify runtime-state records as:

- `active-owned`
- `stale-pid-missing`
- `stale-heartbeat-expired`
- `malformed-state`

Every candidate returns:

```json
{
  "action": "none",
  "safeToTerminate": false,
  "safeToRemoveState": false
}
```

Summary counters for dry-run action are always zero:

- `wouldTerminate: 0`
- `wouldRemoveState: 0`

## Apply Mode

`--apply` is intentionally not implemented.

```bash
npm run byomem:cli -- cleanup --base-dir /path/to/runtime --apply
npm run byomem:cli -- stop --base-dir /path/to/runtime --apply
```

Both commands fail with a JSON error. No process termination or runtime-state deletion is performed.

## Safe Canary Pattern

To test without affecting live Codex MCP processes:

```bash
cd /private/tmp/byomem-ops-polish
rm -rf /tmp/byomem-ops-polish-runtime
BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime npm run build
```

Start worktree MCP servers through a test harness or stdio client with:

```text
BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime
```

Then inspect:

```bash
BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime \
  node ts/packages/runtime/dist/cli.js status --base-dir /tmp/byomem-ops-polish-runtime

BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime \
  node ts/packages/runtime/dist/cli.js cleanup --base-dir /tmp/byomem-ops-polish-runtime
```

Do not point canary commands at `~/.byomem/runtime` unless you are intentionally inspecting the live runtime.

