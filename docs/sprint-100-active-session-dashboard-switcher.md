# Sprint 100: Active Session Dashboard Switcher

> Use `sprint-implementation` to execute this plan task-by-task after review.

## Implementation Status

Implemented. Sprint 100 added safe runtime-state session/project identity, bounded active context options in dashboard JSON/static HTML, and explicit `dashboard --serve --interactive` GET-only context/dashboard routes. Runtime-info/capability-inventory work remains deferred and is not part of this sprint.

## Objective

Add a read-only dashboard view of active BYOMem sessions/projects and an opt-in served dashboard switcher that lets operators switch between active contexts.

This sprint replaces the earlier Sprint 100 runtime-info/capability-inventory direction. The useful operator question is: "Which BYOMem sessions/projects are active, healthy, stale, or duplicated, and what does the selected one look like?"

## Success Criteria

- Runtime-state records can carry additive safe session/project identity without breaking existing v1 records.
- Dashboard JSON includes bounded active session/project context options derived from safe runtime-state/status/doctor evidence.
- Static snapshot dashboard remains script-free and shows the selected context plus a non-interactive context summary.
- `dashboard --serve` remains backward-compatible as a one-file static snapshot unless an explicit interactive flag is used.
- An explicit served interactive mode renders a dropdown for active sessions/projects and uses GET-only read-only JSON endpoints for context lists and selected dashboard models.
- Context switching never exposes raw `argv`, `cwd`, environment values, secrets, raw session transcript ids, or mutation controls.
- Dashboard/session switcher code does not scan files, update graphs, refresh embeddings, cleanup/stop processes, write config, create runtime stores, or probe live MCP transports.
- Existing dashboard, runtime-state, cleanup/stop, status, doctor, open, serve, and profile regressions remain green.
- Version files are bumped and aligned when implementation code changes land.

## Scope

### In Scope

- Add an optional safe identity object to runtime-state process registration and parsing.
- Preserve compatibility with existing runtime-state records that do not have session/project identity.
- Add a pure active-context model for dashboard session/project options.
- Group runtime records into active context options by safe identity, not by raw `cwd` or raw process arguments.
- Add bounded selected-context metadata to `DashboardModel`.
- Add a static, non-interactive context summary to HTML snapshots.
- Add an explicit opt-in served interactive dashboard mode, for example `dashboard --serve --interactive`.
- Add GET-only server endpoints for context list and selected dashboard JSON.
- Add RED tests first for runtime-state identity, active context grouping, served switcher routes, secret omission, and read-only boundaries.
- Update dashboard checklist, README, runbook docs, and version files after implementation.

### Out Of Scope

- Cleanup, stop, kill, prune, delete, unregister, remove, reconnect, repair, scan, graph update, semantic refresh, or config-write actions from the dashboard.
- Live MCP discovery, MCP client transports, stdio startup, or tool calls during dashboard generation.
- Watch mode as a general regeneration primitive outside the explicit served interactive switcher.
- WebSockets, authenticated proxy, origin allowlists, governance actions, replay playback, or mutation-capable UI.
- Inferring project identity from raw `cwd` for dashboard grouping.
- Exposing raw session ids, raw transcript paths, raw `argv`, raw `cwd`, or environment values.

## Orchestration Investigation Summary

Three read-only explorer tracks inspected runtime identity, dashboard/serve mechanics, and safety boundaries.

Runtime-state findings:

- `ts/packages/runtime/src/runtime-state.ts` records process identity and health: role, server name, pid, ppid, argv, cwd, entrypoint, runtime version, startedAt, and lastHeartbeatAt.
- Inventory adds state, stale reason, path, malformed records, warnings, and counts.
- `status-report.ts` exposes process counts, roles, stale/malformed counts, duplicate active roles, and warnings.
- `doctor.ts` exposes safe per-record process evidence through `runtime-state.process-liveness`, including pid/ppid/entrypoint/version/timestamps/path, but intentionally omits raw argv and cwd.
- Project identity exists separately in `project-context.ts`; it is not attached to runtime process records.
- Current records cannot reliably group active processes by BYOMem session/project. `cwd` is tempting but unsafe and already protected by Sprint 99 no-secret tests.

Dashboard/serve findings:

- `dashboard.ts` owns pure model construction and HTML rendering.
- `dashboard-server.ts` currently serves one generated static HTML snapshot from memory at `/`, `/index.html`, and the output basename.
- `cli.ts` owns `dashboard --serve`, `--host`, `--port`, report emission, and injectable server dependencies.
- Static dashboard tests intentionally forbid scripts, forms, buttons, remote assets, event handlers, and executable controls.
- A real dropdown should therefore be an explicit served interactive mode, not a change to the static snapshot contract.

Safety-boundary findings:

- Existing source-guard patterns in Sprint 94/95/99 block dashboard imports of storage mutation, file-search scan/refresh/hot-index, runtime-state mutation/lifecycle, cleanup/stop, child process, and graph update paths.
- Sprint 100 should extend those guards to the session switcher and served JSON endpoints.
- Missing project/runtime directories must remain no-create paths.

## Workstreams

- `runtime-session-identity`: optional safe identity on runtime-state records and registration.
- `active-context-model`: grouping active/stale/malformed runtime evidence into bounded session/project options.
- `snapshot-context-summary`: static dashboard context summary without scripts or controls.
- `served-switcher`: explicit served interactive mode, dropdown UI, and GET-only JSON endpoints.
- `read-only-boundary`: source guards, secret omission, no-create canaries, and fail-closed flags.
- `docs-version-verify`: checklist/docs/version/test/build/index refresh.

## Expected File Changes

```json
{
  "new": [
    "ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts",
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ],
  "modified": [
    "README.md",
    "docs/agentmemory-to-byomem-dashboard-checklist.md",
    "docs/byomem-runtime-operations-runbook.md",
    "package.json",
    "package-lock.json",
    "ts/packages/runtime/package.json",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/src/doctor.ts",
    "ts/packages/runtime/src/mcp/runtime-state-lifecycle.ts",
    "ts/packages/runtime/src/runtime-state.ts",
    "ts/packages/runtime/src/status-report.ts",
    "ts/packages/runtime/src/version.ts"
  ],
  "deleted": []
}
```

Decision rules:

- Do not infer dashboard project/session grouping from raw `cwd`.
- Preserve existing runtime-state records as valid; identity must be additive and optional.
- Keep static snapshot output no-script/no-controls.
- Gate interactive dropdown behavior behind an explicit served-mode flag.
- Keep all server endpoints GET-only and read-only.
- Interactive served endpoints must use startup-cached or explicitly injected read-only evidence, not ad hoc live probing or mutation-prone collection.

## Proposed Runtime Identity Contract

Runtime process records should gain an optional safe identity object:

```ts
type RuntimeProcessIdentity = {
  projectKey: string | null;
  projectDisplayName: string | null;
  projectBaseDir: string | null;
  projectSource: 'explicit' | 'active-project' | 'git' | 'env' | 'unknown';
  sessionKey: string | null;
  sessionLabel: string | null;
  clientInstanceId: string | null;
};
```

Rules:

- `projectBaseDir` may be shown only under the same path-exposure policy as existing dashboard project identity.
- `sessionKey` must be generated or hashed if derived from a raw external/session id.
- `sessionLabel` must be bounded and display-safe.
- Raw `cwd`, raw `argv`, environment values, raw session transcript ids, and config paths must not be copied into this identity object.
- Existing records without identity parse as `identity: null` or equivalent.

### Identity Normalization Rules

- Identity is optional on runtime process schema version `1`; implementation may add a new parser branch for a later schema version only if RED tests prove the migration boundary is necessary.
- The parser must preserve safe identity fields for new records while continuing to accept existing v1 records without identity.
- `projectKey`, `projectDisplayName`, `sessionKey`, `sessionLabel`, and `clientInstanceId` must be bounded strings. Recommended maximums: 96 chars for keys, 128 chars for labels, and 64 chars for client ids.
- Keys must be normalized to display-safe ASCII, for example lowercase letters, digits, `.`, `_`, and `-`; labels may preserve broader printable text only after HTML escaping and length bounds.
- If `sessionKey` is derived from a raw external session id, transcript path, or client id, store only a stable hash or generated opaque key. Do not store the raw value.
- `clientInstanceId` is optional operational metadata. If populated from a raw client/runtime value, store a bounded opaque id, not a hostname, token, process command, transcript path, or environment-derived secret.
- `projectSource` may describe where identity came from, but `env`, `git`, `active-project`, or `cwd` source labels must not authorize copying raw environment values, `.git` paths, or `cwd` into records.
- `projectBaseDir` follows the same exposure policy as existing dashboard project identity. If that policy is too broad for a served multi-context list, the active context model should omit or relativize it rather than exposing more filesystem structure.

## Proposed Dashboard Context Contract

```ts
type DashboardActiveContextPanel = {
  selectedContextId: string;
  options: DashboardContextOption[];
  warnings: string[];
};

type DashboardContextOption = {
  contextId: string;
  status: 'ready' | 'degraded' | 'stale' | 'unknown';
  label: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  projectBaseDir: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
  roles: string[];
  processCounts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  evidenceConfidence: 'definite' | 'constrained' | 'not-applicable';
  warnings: string[];
};
```

Rules:

- Group by safe `projectKey + sessionKey` when available.
- Records with missing identity group under a bounded `unknown` option.
- Same role in different project/session groups must not be collapsed into one option.
- Bound options and per-option records to small fixed maximums, for example 24 options and 24 process records per selected context.
- Sort options deterministically by status, project display name, session label, last heartbeat, and context id.
- Static HTML renders a context summary but no interactive dropdown.
- Unknown context ids must be deterministic, for example derived from a bounded stable hash of safe fields plus record path hash, not from array order alone.
- If multiple unknown records cannot be safely separated, group them under one `unknown` option and include a bounded warning.
- If options or process records are truncated, add explicit bounded warnings such as `Context options truncated to 24 entries` or `Process records truncated to 24 entries`.
- Runtime-state record paths should not be shown in active context options by default. If a path is needed for diagnostics, expose a bounded relative/runtime-state-local display path or hash, not the raw absolute path, and keep full raw paths out of the served dropdown labels.

## Served Switcher Contract

The served switcher is opt-in and does not alter existing static serve behavior.

Suggested CLI:

```bash
npm run byomem:cli -- dashboard --format html --output /tmp/byomem-dashboard.html --serve --interactive --port 0
```

Suggested GET-only endpoints:

- `GET /` and `GET /index.html`: served interactive dashboard shell when `--interactive` is set.
- `GET /api/contexts`: bounded `DashboardContextOption[]`.
- `GET /api/dashboard.json?contextId=<id>`: selected-context dashboard model.
- Optional later: `GET /api/status.json?contextId=<id>` and `GET /api/doctor.json?contextId=<id>` if raw evidence is needed.

Rules:

- Existing non-interactive `dashboard --serve` keeps serving the generated HTML snapshot only.
- Interactive mode may use a small inline script only in the served interactive shell; static generated HTML must remain script-free.
- Responses use `Cache-Control: no-store`.
- CSP must allow only the minimum needed for the served shell.
- Invalid context ids return structured JSON errors without falling back to arbitrary filesystem paths.
- Loopback remains the default host. `0.0.0.0` remains explicit opt-in.
- No POST/PUT/PATCH/DELETE endpoints are added in this sprint.

### Interactive Endpoint Semantics

- Interactive endpoint handlers must select from startup-cached dashboard/status/doctor/runtime-state evidence, or from explicitly injected pure read-only collectors whose no-create behavior is covered by tests.
- Endpoint handlers must not call MCP client transports, start MCP servers, run `status`/`doctor` through shell commands, scan files, update graphs, refresh embeddings, cleanup/stop, write config, or create runtime artifacts.
- `/api/*` routes are available only in explicit interactive mode. Non-interactive `dashboard --serve` must return 404 or a structured non-interactive error for `/api/*`.
- `GET /api/contexts` and `GET /api/dashboard.json?contextId=<id>` must return JSON with `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.
- The interactive shell must have an explicit CSP contract. Prefer no inline script where practical; if inline script is used, protect it with the narrowest practical CSP policy and test the exact header.
- `POST`, `PUT`, `PATCH`, and `DELETE` to interactive endpoints must fail closed and must not trigger collection, writes, or process actions.
- Invalid, missing, duplicate, or path-like `contextId` values must produce structured errors and must not fall back to filesystem routes or the default context.

## Acceptance Criteria

- **AC100-1:** Runtime-state registration accepts optional safe session/project identity and writes it to records.
- **AC100-2:** Existing v1 runtime-state records without identity still parse and appear in inventories without becoming malformed.
- **AC100-3:** Status/doctor/dashboard projections expose bounded safe identity only; raw argv, raw cwd, raw env values, config paths, and raw session ids are absent.
- **AC100-4:** Dashboard model includes bounded active context options grouped by safe project/session identity.
- **AC100-5:** Multi-project same-role runtime records produce distinct context options.
- **AC100-6:** Missing identity records appear under an explicit unknown context with warnings.
- **AC100-7:** Static HTML snapshots render selected context and context summary without scripts, forms, buttons, dropdowns, event handlers, remote assets, or executable controls.
- **AC100-8:** `dashboard --serve` without `--interactive` preserves existing one-file snapshot behavior.
- **AC100-9:** `dashboard --serve --interactive` serves a read-only dropdown UI and GET-only context/dashboard JSON endpoints.
- **AC100-10:** Server endpoints reject invalid context ids and never serve arbitrary files or mutation routes.
- **AC100-11:** Missing runtime-state/project directories do not create stores, runtime-state directories, DBs, graph artifacts, file-search indexes, queues, or process records.
- **AC100-12:** Source guards block cleanup/stop, process termination/probing, runtime-state mutation/lifecycle, file-search scans/refresh/hot-index, graph update/import, project registry mutation, storage/config mutation, and MCP client transport imports from dashboard/switcher paths.
- **AC100-13:** Existing Sprint 83/84/92/94/95/98/99 dashboard/runtime-state regressions remain green.
- **AC100-14:** Runtime identity parser tests prove old records without identity still parse, new records preserve safe identity, and schema/version handling is explicit.
- **AC100-15:** Static generated HTML contains no interactive/API tokens such as `<script`, `<select`, `<option`, `data-context`, or `/api/`.
- **AC100-16:** Interactive served responses include tested JSON content types, `Cache-Control: no-store`, and an explicit CSP; unsupported HTTP methods fail closed.
- **AC100-17:** Unknown context grouping, id generation, collision handling, and truncation warnings are deterministic.

## Phase 0: RED Tests

### Task 100.0.1: RED Runtime Session Identity Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "100.0.1",
  "category": "test",
  "workstream": "runtime-session-identity",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Runtime process registration accepts optional safe identity fields.",
    "Old records without identity still parse as valid inventory entries.",
    "New records preserve safe identity fields instead of dropping them during parsing.",
    "Schema/version handling for identity is explicit and covered by tests.",
    "Raw argv, cwd, environment values, and raw session ids are not projected as identity.",
    "Identity fields are normalized, bounded, and safe for dashboard JSON/HTML."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts"
  ]
}
```

### Task 100.0.2: RED Active Context Model

Metadata:

```json
{
  "phase": "0",
  "task_id": "100.0.2",
  "category": "test",
  "workstream": "active-context-model",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Dashboard model exposes bounded active context options.",
    "Grouping uses safe project/session identity rather than cwd.",
    "Same-role records from different projects/sessions remain distinct.",
    "Unknown context ids, collision behavior, and truncation warnings are deterministic.",
    "Raw runtime-state absolute paths are omitted, relativized, or hashed in active context options according to the path exposure policy."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ]
}
```

### Task 100.0.3: RED Static Snapshot Context Summary

Metadata:

```json
{
  "phase": "0",
  "task_id": "100.0.3",
  "category": "test",
  "workstream": "snapshot-context-summary",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Static HTML renders selected context and context summary.",
    "Static HTML contains no scripts, forms, buttons, select/dropdown controls, event handlers, remote assets, or executable controls.",
    "Static HTML contains no interactive/API tokens such as <script, <select, <option, data-context, or /api/.",
    "Dynamic context labels and paths are HTML-escaped and bounded."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ]
}
```

### Task 100.0.4: RED Served Switcher Routes

Metadata:

```json
{
  "phase": "0",
  "task_id": "100.0.4",
  "category": "test",
  "workstream": "served-switcher",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Non-interactive dashboard --serve keeps serving the existing static snapshot routes.",
    "Interactive serve mode exposes GET /api/contexts and GET /api/dashboard.json?contextId=...",
    "Interactive endpoints use startup-cached or explicitly injected pure read-only evidence only.",
    "Invalid context ids return structured errors and do not read arbitrary files.",
    "POST, PUT, PATCH, and DELETE fail closed without collection or mutation.",
    "/api/* is unavailable in non-interactive serve mode.",
    "--interactive requires --serve --format html --output <path> and fails before server startup on invalid flag combinations.",
    "JSON endpoints return application/json with Cache-Control: no-store, and the interactive shell has an explicit tested CSP."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ]
}
```

### Task 100.0.5: RED Read-Only Boundary

Metadata:

```json
{
  "phase": "0",
  "task_id": "100.0.5",
  "category": "test",
  "workstream": "read-only-boundary",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Dashboard/switcher paths do not import cleanup, stop, child process, MCP transports, runtime-state lifecycle mutation, file-search scan/refresh/hot-index, graph update/import, registry mutation, or config-write modules.",
    "Empty project/runtime dirs remain no-create during dashboard/switcher generation.",
    "Interactive endpoint handlers also pass no-create canaries for missing runtime-state/project directories.",
    "Mutation-looking flags fail closed before collection."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ]
}
```

## Phase 1: GREEN Implementation

### Task 100.1.1: Implement Runtime Session Identity

Metadata:

```json
{
  "phase": "1",
  "task_id": "100.1.1",
  "category": "impl",
  "workstream": "runtime-session-identity",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/runtime-state.ts",
    "ts/packages/runtime/src/mcp/runtime-state-lifecycle.ts",
    "ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts"
  ],
  "blocked_by": [
    "100.0.1"
  ],
  "acceptance_criteria": [
    "Runtime records support optional safe identity.",
    "Registration can receive explicit identity without deriving it from cwd.",
    "Existing records remain compatible.",
    "Safe identity normalization and schema compatibility rules are implemented exactly as tested."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts ts/packages/runtime/tests/sprint-83-runtime-state.test.ts"
  ]
}
```

### Task 100.1.2: Implement Active Context Model

Metadata:

```json
{
  "phase": "1",
  "task_id": "100.1.2",
  "category": "impl",
  "workstream": "active-context-model",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/status-report.ts",
    "ts/packages/runtime/src/doctor.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [
    "100.0.2",
    "100.1.1"
  ],
  "acceptance_criteria": [
    "DashboardModel includes active context options and selected context metadata.",
    "Grouping uses safe identity and handles unknown identity.",
    "Records and options are bounded and deterministic.",
    "Path exposure, unknown context ids, collision handling, and truncation warnings follow the sprint contract."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-99-runtime-panel-model.test.ts"
  ]
}
```

### Task 100.1.3: Implement Static Context Summary

Metadata:

```json
{
  "phase": "1",
  "task_id": "100.1.3",
  "category": "impl",
  "workstream": "snapshot-context-summary",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [
    "100.0.3",
    "100.1.2"
  ],
  "acceptance_criteria": [
    "Static dashboard renders context summary.",
    "Static no-script/no-control safety contract remains intact.",
    "HTML escaping covers session/project labels and paths."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-99-runtime-panel-rendering.test.ts"
  ]
}
```

### Task 100.1.4: Implement Served Interactive Switcher

Metadata:

```json
{
  "phase": "1",
  "task_id": "100.1.4",
  "category": "impl",
  "workstream": "served-switcher",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ],
  "blocked_by": [
    "100.0.4",
    "100.1.2"
  ],
  "acceptance_criteria": [
    "dashboard --serve remains backward-compatible by default.",
    "dashboard --serve --interactive exposes the dropdown shell and GET-only JSON endpoints.",
    "Interactive mode has no mutation endpoints and no arbitrary file serving.",
    "Interactive endpoint responses use the tested content types, no-store headers, CSP, method rejection, and cached/read-only evidence semantics."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts"
  ]
}
```

## Phase 2: REFACTOR / HARDEN

### Task 100.2.1: Boundary And Compatibility Hardening

Metadata:

```json
{
  "phase": "2",
  "task_id": "100.2.1",
  "category": "refactor",
  "workstream": "read-only-boundary",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/dashboard-server.ts"
  ],
  "blocked_by": [
    "100.1.1",
    "100.1.2",
    "100.1.3",
    "100.1.4"
  ],
  "acceptance_criteria": [
    "Source guards cover switcher-specific forbidden imports and calls.",
    "No-create canaries pass for static and interactive paths.",
    "Secret-bearing injected evidence is omitted from JSON and HTML."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-92-dashboard-cli-boundary.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts"
  ]
}
```

## Phase 3: DOCS / VERSION / VERIFY

### Task 100.3.1: Docs, Version, And Verification

Metadata:

```json
{
  "phase": "3",
  "task_id": "100.3.1",
  "category": "validation",
  "workstream": "docs-version-verify",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "README.md",
    "docs/agentmemory-to-byomem-dashboard-checklist.md",
    "docs/byomem-runtime-operations-runbook.md",
    "package.json",
    "package-lock.json",
    "ts/packages/runtime/package.json",
    "ts/packages/runtime/src/version.ts"
  ],
  "blocked_by": [
    "100.2.1"
  ],
  "acceptance_criteria": [
    "Docs explain active session/project switching, static vs interactive served modes, and read-only limits.",
    "Version files are aligned after code changes.",
    "Focused tests, broader dashboard/runtime regressions, build, diff check, file-search scan, and native graph update pass."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-84-doctor.test.ts ts/packages/runtime/tests/sprint-81-status-command.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-92-dashboard-cli-boundary.test.ts ts/packages/runtime/tests/sprint-94-dashboard-profile.test.ts ts/packages/runtime/tests/sprint-95-dashboard-file-search-health.test.ts ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-dashboard-runtime-base.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-82-process-cleanup-dry-run.test.ts ts/packages/runtime/tests/sprint-96-cleanup-apply.test.ts ts/packages/runtime/tests/sprint-83-runtime-state.test.ts",
    "npm run build",
    "git diff --check"
  ]
}
```

## Verification Plan

- `npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-84-doctor.test.ts ts/packages/runtime/tests/sprint-81-status-command.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-92-dashboard-cli-boundary.test.ts ts/packages/runtime/tests/sprint-94-dashboard-profile.test.ts ts/packages/runtime/tests/sprint-95-dashboard-file-search-health.test.ts ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-dashboard-runtime-base.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-82-process-cleanup-dry-run.test.ts ts/packages/runtime/tests/sprint-96-cleanup-apply.test.ts ts/packages/runtime/tests/sprint-83-runtime-state.test.ts`
- `npm run build`
- `git diff --check`
- BYOMem file-search scan for this repo.
- BYOMem native-source graph update for this repo.
