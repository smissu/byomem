# BYOMem Runtime Operations Runbook

This runbook covers the non-destructive runtime observability surfaces added for BYOMem operations.

## Commands

Use the existing runtime CLI binary:

```bash
npm run byomem:cli -- status --base-dir /path/to/runtime-or-project
npm run byomem:cli -- doctor --base-dir /path/to/runtime-or-project
npm run byomem:cli -- dashboard --base-dir /path/to/runtime-or-project
npm run byomem:cli -- dashboard --base-dir /path/to/runtime-or-project --format html --output /tmp/byomem-dashboard.html
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

Every suggested action is marked `"mode": "read-only"`. `doctor` must not open SQLite handles, create DBs, scan files, update graphs, call embedding providers, remove runtime-state files, or terminate processes.

## Dashboard

`dashboard` renders a compact read-only snapshot from the existing `status` and `doctor` reports. It keeps status components and doctor checks separate so the dashboard does not replace the machine-readable source contracts.

The generated HTML defaults to dark mode and includes a CSS-only light theme path. It adds runtime identity, KPI cards, capability banners, first-run guidance, section summaries, inert command cards, and footer links without adding scripts, browser storage, remote assets, forms, or executable controls.

Default JSON output:

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/runtime-or-project
```

Static HTML output:

```bash
npm run byomem:cli -- dashboard --base-dir /path/to/runtime-or-project --format html --output /tmp/byomem-dashboard.html
```

Rules:

- Omitting `--format` defaults to JSON stdout.
- HTML output requires `--output <path>` and the output parent directory must already exist.
- HTML output is self-contained, non-interactive, dark by default, and light-theme capable through embedded CSS only.
- The command does not serve HTTP, watch files, open a browser, scan files, update graphs, refresh embeddings, run cleanup/stop, or mutate Codex config/runtime data.
- The `codex-config` dashboard evidence comes from host-global `~/.codex/config.toml`, not project-scoped config.
- The HTML write path prints a JSON write report with `command`, `format`, `outputPath`, and `bytesWritten`.

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

Repo-local commands are necessary but not sufficient for installed/global verification. When the global Pi/Codex BYOMem extension is available, verify the active Codex-facing MCP runtime-info surface without mutating runtime config. Expected evidence is `byomem_runtime_info.runtime.packageVersion === "0.1.12"` and `byomem_runtime_info.server.version === "0.1.12"` from the `byomem_runtime_info` tool result after the active runtime is rebuilt and restarted.

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
npm run byomem:cli -- doctor --base-dir /path/to/runtime --apply
```

All three commands fail with a JSON error. No process termination or runtime-state deletion is performed.

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
