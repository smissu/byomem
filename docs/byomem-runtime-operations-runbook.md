# BYOMem Runtime Operations Runbook

This runbook covers the non-destructive runtime observability surfaces added for BYOMem operations.

## Commands

Use the existing runtime CLI binary:

```bash
npm run byomem:cli -- status --base-dir /path/to/runtime-or-project
npm run byomem:cli -- doctor --base-dir /path/to/runtime-or-project
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html
npm run byomem:cli -- connect codex --runtime-entrypoint /path/to/byomem/ts/packages/runtime/dist
npm run byomem:cli -- remove codex --runtime-entrypoint /path/to/byomem/ts/packages/runtime/dist
npm run byomem:cli -- cleanup --base-dir /path/to/runtime
npm run byomem:cli -- stop --base-dir /path/to/runtime
```

`status`, `doctor`, `dashboard`, `connect codex`, `remove codex`, `cleanup`, and `stop` are JSON-first commands.

## Status

`status` is stat-only. It reports:

- runtime version
- project and runtime base paths
- memory, file-search, and graph artifact paths
- artifact existence, size, and mtime
- runtime-state MCP process inventory summary
- duplicate active MCP role summaries at `mcpProcesses.duplicateActiveRoles`

It must not open SQLite handles, create DBs, scan files, update graphs, or inspect host process tables.

## Doctor

`doctor` is a read-only diagnostic report. It builds on the stat-only status surface and adds check records with stable ids, severity, evidence confidence, and read-only suggested commands.

It reports:

- runtime version alignment
- memory, file-search, and graph artifact readiness
- Codex config presence when readable
- runtime-state inventory readability
- MCP process liveness evidence, stale records, and duplicate active roles
- explicit skips for diagnostics that would require opening stores or calling providers
- a read-only boundary check confirming mutation modes are unavailable

Process liveness evidence uses this confidence vocabulary:

- `definite`: the PID and runtime-state evidence was checked directly in the current environment
- `constrained`: the evidence is useful but should be confirmed in an isolated canary before cleanup
- `not-applicable`: the check does not rely on process liveness

Set `BYOMEM_DOCTOR_PROCESS_EVIDENCE_CONFIDENCE=constrained` when running the CLI in an environment where PID liveness probes are known to be namespace-limited or otherwise incomplete.

Duplicate active role evidence is reported as both the compatibility string list `evidence.duplicateActiveRoles` and structured `evidence.duplicateActiveRoleSummaries` records containing role, count, pid, server name, entrypoint, and runtime-state JSON path.

Every suggested action is marked `"mode": "read-only"`. `doctor` must not open SQLite handles, create DBs, scan files, update graphs, call embedding providers, remove runtime-state files, refresh MCP heartbeats, or terminate processes.

## Dashboard

`dashboard` renders a compact read-only snapshot from the existing `status` and `doctor` reports. It keeps status components and doctor checks separate so the dashboard does not replace the machine-readable source contracts.

The generated HTML defaults to dark mode and includes a CSS-only light theme path. It adds runtime identity, KPI cards, capability banners, first-run guidance, section summaries, inert command cards, and footer links without adding scripts, browser storage, remote assets, forms, or executable controls.

Default JSON output:

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime
```

Static HTML output:

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html
```

Static loopback serve output:

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/project --runtime-base-dir /path/to/runtime --format html --output /tmp/byomem-dashboard.html --serve --port 0
```

Rules:

- Omitting `--format` defaults to JSON stdout.
- HTML output requires `--output <path>` and the output parent directory must already exist.
- HTML output is self-contained, non-interactive, dark by default, and light-theme capable through embedded CSS only.
- `dashboard --serve` binds only to `127.0.0.1`, serves the generated HTML snapshot from memory, accepts `--port 0` for OS-selected ports or `--port 1..65535`, prints a JSON serve report with `url`, `host`, `port`, and `pid`, and closes on normal termination.
- `dashboard --runtime-base-dir <path>` selects the runtime-state source for status, doctor, and the static Runtime processes panel while preserving `--base-dir` as the project/profile base.
- The Runtime processes panel is read-only and derives from status/doctor evidence. It shows counts, roles, duplicate active roles, active/stale process records, malformed record warnings, and PID evidence confidence without exposing raw argv, cwd, environment values, or executable cleanup/stop controls.
- `dashboard --open` opens the generated file for non-serve HTML output and opens the reported loopback URL for serve output.
- The command does not watch files, scan files, update graphs, refresh embeddings, run cleanup/stop, mutate Codex config/runtime data, or serve arbitrary directories/files.
- The `codex-config` dashboard evidence comes from host-global `~/.codex/config.toml`, not project-scoped config.
- The HTML write/open/serve paths print JSON reports with `reportSchemaVersion`, `command`, `format`, `outputPath`, and `bytesWritten`; serve reports also include `served`, `url`, `host`, `port`, `pid`, and `openRequested`.

## Connect Codex

`connect codex` bootstraps Codex to use BYOMem without disturbing running MCP processes. It is one side of the paired lifecycle operations for Codex integration. The default mode is dry-run; add `--apply` only after reviewing the JSON report.

It manages:

- `~/.codex/config.toml`, or `--codex-config-path`
- `<project>/AGENTS.md`, or `--project-dir`
- split BYOMem MCP entries for memory, graph, and file-search using `--runtime-entrypoint`

The command creates backups before changing existing files. It refuses stale, duplicate, or conflicting BYOMem MCP entries and reports them as `refusals` for manual cleanup.

## Remove Codex

`remove codex` is the conservative inverse of `connect codex`. It is the rollback side of the paired lifecycle operations for Codex integration. The default mode is dry-run first; add `--apply` only after reviewing the JSON report. This is an apply-after-review workflow, not an automatic uninstall.

It manages:

- `~/.codex/config.toml`, or `--codex-config-path`
- `<project>/AGENTS.md`, or `--project-dir`
- `<project>/.codex/hooks.json`, or `--project-dir`
- stale BYOMem-owned runtime-state records under `--base-dir`

Safe uninstall means integration rollback does not delete durable data. `remove codex` reads global `~/.codex/config.toml` by default, so dry-run output must be reviewed as an all-project Codex config change. The command creates `.byomem-remove-backup-{timestamp}` backups before changing existing config, AGENTS, or hooks files; those backups cover modified config/integration files, not durable BYOMem data.

Recognized removable artifacts are canonical BYOMem MCP config sections, the marked AGENTS guidance block, canonical Codex hook commands, and stale BYOMem-owned runtime-state records. It refuses ambiguous or edited BYOMem-looking MCP sections, guidance blocks, and hooks, and it preserves durable data such as memory, file-search, graph, queue, runtime DB, embedding cache, and runtime artifacts by default.

`--delete-data`, `--kill-processes`, and `--force` are intentionally rejected in this sprint. `remove codex` does not kill or terminate live processes.

## Runtime Version Evidence

Use repo-local commands as necessary release evidence:

```bash
npm run byomem:cli -- status
node ts/packages/runtime/dist/cli.js status
```

Repo-local commands are necessary but not sufficient for installed/global verification. When the global Pi/Codex BYOMem extension is available, verify the active Codex-facing MCP runtime-info surface without mutating runtime config. Expected evidence is `byomem_runtime_info.runtime.packageVersion === "0.1.24"` and `byomem_runtime_info.server.version === "0.1.24"` from the `byomem_runtime_info` tool result after the active runtime is rebuilt and restarted.

## Extension Exposure Decision Record

Initial decision: `defer`.

Rationale: `remove codex` is dry-run-first and conservative, but exposing an uninstall command in Pi/Codex help or menus increases accidental discoverability. For this release, docs point advanced operators to explicit CLI usage and defer menu/help exposure unless implementation records an explicit override with rationale, tests, exact files, and rollback plan.

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

Canonical BYOMem MCP roles are `bootstrap`, `readonly`, `operations`, `memory`, `graph`, and `file-search`. Startup registration checks active canonical records for the same role in the selected runtime base, but duplicate handling is observe-by-default so Codex MCP startup and handshake do not fail simply because old live records or processes still exist. In observe mode, a second active canonical same-role record is registered and remains visible through `status` and `doctor` duplicate summaries; a stale same-role record does not block startup. Active non-canonical same-role records are diagnostics-only evidence and do not block canonical startup.

Set `BYOMEM_MCP_DUPLICATE_POLICY=strict` for canaries or tests that should retain the previous fail-closed guard. In strict mode, an active canonical same-role record is refused before writing a second record. If a race creates another active canonical same-role record after preflight, the attempted startup unregisters only its own exact record and fails closed. Existing live duplicate processes remain operator-owned; this guard does not kill or reconcile already-running processes.

## Cleanup And Stop

`cleanup` is dry-run by default. It classifies runtime-state records as:

- `active-owned`
- `stale-pid-missing`
- `stale-heartbeat-expired`
- `malformed-state`

Dry-run candidates include whether stale state would be removed:

```json
{
  "action": "would-remove-state",
  "safeToTerminate": false,
  "safeToRemoveState": true
}
```

`safeToTerminate` is always false. Cleanup never kills or signals processes.

`cleanup --apply` removes only stale BYOMem-owned runtime-state process records whose PIDs are no longer running. It re-reads each candidate immediately before deletion and preserves/refuses records that are active, heartbeat-expired with a live PID, malformed, ownership-mismatched, or changed during the second pass.

Cleanup is not duplicate-active remediation. Active duplicate records are preserved, and cleanup output must not suggest that `cleanup --apply` can fix live duplicate MCP processes. Use `doctor` or `status` to identify duplicate active roles, then stop or restart the owning external sessions manually.

`stop` remains dry-run only. `stop --apply` is intentionally not implemented because process termination is out of scope.

## Apply Mode

Use this sequence when stale runtime-state records cause degraded status:

```bash
npm run byomem:cli -- cleanup --base-dir /path/to/runtime
npm run byomem:cli -- cleanup --base-dir /path/to/runtime --apply
npm run byomem:cli -- doctor --base-dir /path/to/runtime --json
```

`cleanup --apply` exits 0 for successful removals, no-op runs, and safety refusals. It exits 1 for invalid flags, contract errors, or deletion failures.

These flags fail closed for both `cleanup` and `stop`:

- `--delete-data`
- `--kill-processes`
- `--force`
- `--apply --dry-run`

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
  node ts/packages/runtime/dist/cli.js doctor --base-dir /tmp/byomem-ops-polish-runtime

BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime \
  node ts/packages/runtime/dist/cli.js status --base-dir /tmp/byomem-ops-polish-runtime

BYOMEM_RUNTIME_BASE_DIR=/tmp/byomem-ops-polish-runtime \
  node ts/packages/runtime/dist/cli.js cleanup --base-dir /tmp/byomem-ops-polish-runtime
```

Do not point canary commands at `~/.byomem/runtime` unless you are intentionally inspecting the live runtime.
