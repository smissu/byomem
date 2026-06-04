# Sprint 101: Served Dashboard Refresh And Stale Context Policy

> Use `sprint-implementation` to execute this plan task-by-task after review.

## Implementation Status

Planned.

## Objective

Make the explicit served interactive dashboard refresh active BYOMem context evidence safely, show lifecycle confidence clearly, and expose stale-context policy as read-only operator evidence.

Sprint 100 made the dropdown possible, but the served dashboard still uses startup-cached context evidence. Sprint 101 answers the next operator question: "Is this served dashboard view current, which contexts are stale or uncertain, and can I refresh the view without restarting the server or mutating BYOMem state?"

## Success Criteria

- `dashboard --serve --interactive` can refresh active contexts and selected dashboard snapshots from current read-only runtime evidence without restarting the server.
- Non-interactive `dashboard --serve` remains a static one-file snapshot and does not expose `/api/*`.
- Static generated HTML remains script-free, control-free, API-token-free, and self-contained.
- Interactive refresh uses GET-only endpoints, `Cache-Control: no-store`, JSON content types, and the existing served-dashboard CSP boundary.
- Manual refresh and optional auto-refresh controls are visible only in explicit interactive served mode.
- Auto-refresh is off unless explicitly requested or toggled, interval-bounded, cancellable, and cannot create stores, indexes, runtime-state dirs, graph artifacts, queues, or process records.
- Dashboard context options show read-only lifecycle/confidence states such as active, stale, heartbeat-expired, missing-identity, malformed, duplicate-role, unknown, definite, constrained, not-applicable, and not-collected where appropriate.
- Stale cleanup policy is display-only. The dashboard may show safe suggested commands, but it must not cleanup, stop, kill, delete, prune, unregister, reconnect, repair, scan, update graph, refresh embeddings, or write config.
- Dashboard refresh code never probes live MCP transports, starts MCP servers, shells out to commands, or calls mutation-capable runtime paths.
- Existing Sprint 98, 99, and 100 dashboard/runtime-state regressions remain green.
- Version files are bumped and aligned when implementation code changes land.

## Scope

### In Scope

- Add a pure read-only served-dashboard refresh provider/collector contract.
- Refresh `/api/contexts`, `/api/dashboard.json?contextId=...`, and `/api/dashboard.html?contextId=...` from current read-only evidence in interactive mode.
- Add refresh metadata to dashboard/server responses: generated time, refresh source, cache state, selected context id, and refresh error state.
- Add interactive-only manual refresh control.
- Add explicit opt-in auto-refresh polling controls with bounded interval.
- Add lifecycle/confidence display for context groups and stale runtime-state evidence.
- Add read-only stale policy summary: eligible stale records, refused/unsafe stale records, heartbeat-expired records, malformed records, duplicate-role evidence, and copy-only cleanup guidance.
- Add RED tests first for refresh provider semantics, served API refresh, UI controls, lifecycle/confidence model, and read-only boundary.
- Update checklist, README/docs index, runbook docs, and version files after implementation.

### Out Of Scope

- `dashboard --watch` static regeneration mode.
- WebSockets, authenticated proxy, origin allowlists, replay playback, graph canvas, browser storage, or background daemon behavior.
- Any POST, PUT, PATCH, DELETE, mutation, cleanup, stop, kill, prune, delete, unregister, remove, reconnect, repair, scan, graph update, semantic refresh, or config-write dashboard endpoint.
- Live MCP discovery, MCP client transports, stdio startup, or tool calls during dashboard generation or refresh.
- Exposing raw runtime-state record paths, transcript ids, `argv`, `cwd`, environment values, hostnames, tokens, config paths, or full process commands.
- File-search or graph mutation, including refresh buttons that run scan/index/graph-update.
- Changing MCP runtime-state registration unless a RED test proves lifecycle metadata cannot be derived safely from existing runtime-state/status/doctor evidence.

## Planning Investigation Summary

Two orchestration planners reviewed Sprint 100 boundaries and current code/test impact.

Code impact findings:

- `ts/packages/runtime/src/dashboard.ts` owns context models, runtime process panel rendering, context status, selected context summaries, capability banners, and static HTML rendering.
- `ts/packages/runtime/src/dashboard-server.ts` currently serves startup-cached `contexts` and selected dashboard JSON/HTML from in-memory evidence.
- `ts/packages/runtime/src/cli.ts` currently rejects dashboard `--watch` and `--refresh`, validates `--interactive`, collects dashboard evidence once, and prebuilds per-context HTML.
- `ts/packages/runtime/src/runtime-state.ts` owns runtime process records, identity normalization, inventory state/stale classification, and duplicate active role summaries.
- `ts/packages/runtime/src/status-report.ts` and `ts/packages/runtime/src/doctor.ts` already expose read-only runtime-state counts, stale/malformed evidence, warnings, and confidence.
- Dynamic refresh needs an injected read-only provider contract, not ad hoc collection inside HTTP route handlers.

Safety and scope findings:

- The sprint should be read-only freshness and stale-context policy, not a general live dashboard sprint.
- Cleanup belongs to explicit CLI operator paths, not dashboard endpoints.
- Refresh must mean "re-read current safe dashboard evidence" only, not file-search scan, graph update, semantic refresh, MCP probing, or process lifecycle action.
- Static dashboard contracts from Sprint 88/92/98/99/100 must remain unchanged.

## Workstreams

- `dashboard-refresh-contract`: pure read-only provider that returns dashboard model, selected HTML, contexts, generated timestamp, source, and errors in one consistent snapshot.
- `served-refresh-api`: interactive-only GET endpoints use the provider while non-interactive serve remains static.
- `refresh-ui-controls`: manual refresh, optional auto-refresh toggle/interval, last refreshed, and refresh error state in the served shell.
- `lifecycle-policy-model`: read-only stale context and cleanup-policy summary derived from runtime-state/status/doctor evidence.
- `confidence-states`: normalize and render operator-facing confidence states without exposing unsafe evidence.
- `read-only-boundary`: source guards, no-create canaries, method rejection, and regression coverage.
- `docs-version-verify`: checklist/runbook/docs/version/test/build/index refresh.

## Expected File Changes

```json
{
  "new": [
    "ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts",
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts",
    "ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts",
    "ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts"
  ],
  "modified": [
    "README.md",
    "docs/README.md",
    "docs/agentmemory-to-byomem-dashboard-checklist.md",
    "docs/byomem-runtime-operations-runbook.md",
    "package.json",
    "package-lock.json",
    "ts/packages/runtime/package.json",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/src/doctor.ts",
    "ts/packages/runtime/src/runtime-state.ts",
    "ts/packages/runtime/src/status-report.ts",
    "ts/packages/runtime/src/version.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts",
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ],
  "deleted": []
}
```

## Decision Rules

- Use a provider/injection pattern for dynamic refresh. Do not perform unrelated collection, shell commands, or live probing directly inside route handlers.
- Use one bounded `now`/`generatedAt` per refresh snapshot so status, doctor, dashboard model, context options, and HTML are internally consistent.
- Keep refresh GET-only and read-only. Unsupported methods fail closed before any collection or mutation.
- Keep non-interactive serve behavior byte-for-byte equivalent except for intentional header-safe changes covered by tests.
- Do not repurpose `--refresh` to mean file-search or embedding refresh. If a dashboard refresh flag is added, name it narrowly, for example `--interactive-refresh` or `--auto-refresh`.
- Auto-refresh interval must have a low/high bound and a default that avoids aggressive polling.
- Stale cleanup policy may recommend copy-only CLI commands but must not execute them.
- Do not expose raw runtime-state paths or unsafe process fields in context labels, JSON, HTML, warnings, or suggested actions.

## Proposed Refresh Contract

```ts
type DashboardRefreshSource = 'startup-cache' | 'read-only-refresh' | 'explicit-injection';

type DashboardRefreshSnapshot = {
  generatedAt: string;
  source: DashboardRefreshSource;
  selectedContextId: string;
  contexts: DashboardServerContextEvidence[];
  selectedDashboardModel: DashboardModel;
  selectedDashboardHtml: string;
  warnings: string[];
  errors: DashboardRefreshError[];
};

type DashboardRefreshProvider = (request: {
  selectedContextId?: string;
  now?: Date;
}) => Promise<DashboardRefreshSnapshot>;
```

Rules:

- The provider owns read-only status/doctor/dashboard collection and per-context HTML rendering.
- The server owns request validation, method rejection, headers, and response shaping.
- Unknown context ids return structured JSON errors and do not fall back to filesystem routes or default context.
- Refreshed HTML may only come from `renderByomemDashboardHtml()` over a trusted dashboard model.
- Refresh errors must be bounded and display-safe.

## Proposed Lifecycle Policy Model

```ts
type DashboardContextLifecycleState =
  | 'active'
  | 'stale'
  | 'heartbeat-expired'
  | 'pid-missing'
  | 'missing-identity'
  | 'malformed'
  | 'duplicate-role'
  | 'unknown';

type DashboardLifecyclePolicySummary = {
  state: 'ready' | 'degraded' | 'unknown';
  evidenceConfidence: 'definite' | 'constrained' | 'not-applicable' | 'not-collected';
  counts: {
    active: number;
    stale: number;
    heartbeatExpired: number;
    pidMissing: number;
    missingIdentity: number;
    malformed: number;
    duplicateRoleGroups: number;
  };
  copyOnlySuggestedActions: DashboardCommandCard[];
  warnings: string[];
};
```

Rules:

- This model is presentation-only.
- Cleanup eligibility is informational and must not remove state.
- `heartbeat-expired` while PID is running should be shown as constrained/unsafe for cleanup.
- `pid-missing` can show a copy-only cleanup dry-run/apply command, but not a button that executes it.
- Missing identity should be visible so operators understand fallback grouping.

## Phase 0: RED Tests

### Task 101.0.1: RED Refresh Provider Contract

Metadata:

```json
{
  "phase": "0",
  "task_id": "101.0.1",
  "category": "test",
  "workstream": "dashboard-refresh-contract",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Provider returns one internally consistent snapshot with generatedAt, contexts, selected model, selected HTML, warnings, and errors.",
    "Provider uses shared now/generatedAt for dashboard/status/doctor evidence.",
    "Unknown context ids return structured errors without filesystem fallback.",
    "Refreshed HTML is generated only from trusted dashboard renderer output."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts"
  ]
}
```

### Task 101.0.2: RED Served Refresh API

Metadata:

```json
{
  "phase": "0",
  "task_id": "101.0.2",
  "category": "test",
  "workstream": "served-refresh-api",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Interactive /api/contexts reflects provider changes after startup.",
    "Interactive /api/dashboard.json and /api/dashboard.html refresh selected context data from the provider.",
    "Non-interactive dashboard --serve keeps /api/* unavailable.",
    "Responses include JSON content type, no-store cache, and tested CSP/header behavior.",
    "POST, PUT, PATCH, and DELETE fail closed without collection or mutation."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ]
}
```

### Task 101.0.3: RED Refresh UI Controls

Metadata:

```json
{
  "phase": "0",
  "task_id": "101.0.3",
  "category": "test",
  "workstream": "refresh-ui-controls",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Interactive served shell renders manual refresh controls, last-refresh timestamp, and refresh state.",
    "Auto-refresh controls are explicit, bounded, and cancellable.",
    "Static generated HTML contains no refresh controls, scripts, select controls, or /api/ tokens.",
    "Auto-refresh uses GET requests only."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ]
}
```

### Task 101.0.4: RED Lifecycle Policy Model

Metadata:

```json
{
  "phase": "0",
  "task_id": "101.0.4",
  "category": "test",
  "workstream": "lifecycle-policy-model",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Dashboard model exposes read-only lifecycle policy summary.",
    "Stale, heartbeat-expired, pid-missing, malformed, duplicate-role, missing-identity, and unknown states are represented distinctly.",
    "Cleanup guidance is copy-only and never executable from dashboard JSON or HTML.",
    "Raw argv, cwd, env, transcript ids, and raw runtime-state paths are omitted."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ]
}
```

### Task 101.0.5: RED Read-Only Boundary

Metadata:

```json
{
  "phase": "0",
  "task_id": "101.0.5",
  "category": "test",
  "workstream": "read-only-boundary",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts",
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Dashboard refresh paths do not import cleanup apply, stop, process termination, child process, MCP transports, file-search scan/refresh/hot-index, graph update/import, registry mutation, or config-write modules.",
    "No-create canaries pass for refresh provider and interactive endpoints.",
    "Mutation-looking flags still fail closed unless explicitly safe and covered by Sprint 101 tests.",
    "Refresh does not create runtime stores, file-search DBs, graph DBs, queues, runtime-state dirs, or process records."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts"
  ]
}
```

## Phase 1: GREEN Implementation

### Task 101.1.1: Implement Refresh Provider Contract

Metadata:

```json
{
  "phase": "1",
  "task_id": "101.1.1",
  "category": "impl",
  "workstream": "dashboard-refresh-contract",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts"
  ],
  "blocked_by": [
    "101.0.1"
  ],
  "acceptance_criteria": [
    "A pure read-only provider returns consistent dashboard refresh snapshots.",
    "Provider can be injected into the served dashboard server.",
    "Provider does not shell out, probe MCP transports, scan files, update graphs, refresh embeddings, or mutate runtime state."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts"
  ]
}
```

### Task 101.1.2: Implement Served Refresh API

Metadata:

```json
{
  "phase": "1",
  "task_id": "101.1.2",
  "category": "impl",
  "workstream": "served-refresh-api",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ],
  "blocked_by": [
    "101.0.2",
    "101.1.1"
  ],
  "acceptance_criteria": [
    "Interactive endpoints refresh from provider on GET.",
    "Non-interactive serve remains static.",
    "Unknown context ids and unsupported methods fail closed.",
    "Headers and CSP are tested."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts"
  ]
}
```

### Task 101.1.3: Implement Refresh UI Controls

Metadata:

```json
{
  "phase": "1",
  "task_id": "101.1.3",
  "category": "impl",
  "workstream": "refresh-ui-controls",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts"
  ],
  "blocked_by": [
    "101.0.3",
    "101.1.2"
  ],
  "acceptance_criteria": [
    "Interactive shell exposes manual refresh and optional bounded auto-refresh.",
    "Refresh state and last refreshed timestamp update in the served UI.",
    "Auto-refresh is explicit and cancellable.",
    "Static dashboard remains non-interactive."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ]
}
```

### Task 101.1.4: Implement Lifecycle Policy And Confidence Model

Metadata:

```json
{
  "phase": "1",
  "task_id": "101.1.4",
  "category": "impl",
  "workstream": "lifecycle-policy-model",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/status-report.ts",
    "ts/packages/runtime/src/doctor.ts",
    "ts/packages/runtime/src/runtime-state.ts",
    "ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts",
    "ts/packages/runtime/tests/sprint-100-active-context-model.test.ts"
  ],
  "blocked_by": [
    "101.0.4"
  ],
  "acceptance_criteria": [
    "Lifecycle policy summary is derived from read-only runtime evidence.",
    "Confidence states are visible and distinct.",
    "Cleanup guidance is copy-only and never executable.",
    "Unsafe raw process fields stay omitted."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-84-doctor.test.ts ts/packages/runtime/tests/sprint-81-status-command.test.ts"
  ]
}
```

## Phase 2: REFACTOR / HARDEN

### Task 101.2.1: Boundary And No-Create Hardening

Metadata:

```json
{
  "phase": "2",
  "task_id": "101.2.1",
  "category": "refactor",
  "workstream": "read-only-boundary",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/src/dashboard.ts",
    "ts/packages/runtime/src/dashboard-server.ts",
    "ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts",
    "ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts"
  ],
  "blocked_by": [
    "101.1.1",
    "101.1.2",
    "101.1.3",
    "101.1.4"
  ],
  "acceptance_criteria": [
    "Source guards cover all refresh paths.",
    "No-create canaries pass for provider and endpoints.",
    "Mutation-looking dashboard flags remain fail-closed unless explicitly safe and tested.",
    "Secrets and raw process fields are absent from refreshed JSON and HTML."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts"
  ]
}
```

### Task 101.2.2: Refresh Consistency And UI Regression Review

Metadata:

```json
{
  "phase": "2",
  "task_id": "101.2.2",
  "category": "validation",
  "workstream": "refresh-ui-controls",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts",
    "ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ],
  "blocked_by": [
    "101.2.1"
  ],
  "acceptance_criteria": [
    "Context list, selected panel, and embedded snapshot stay in sync after manual refresh.",
    "Auto-refresh preserves selected context when still present and handles removed contexts with structured error state.",
    "Rendered text fits existing dashboard layout and avoids overlap/overflow-prone labels."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts"
  ]
}
```

## Phase 3: DOCS / VERSION / VERIFY

### Task 101.3.1: Docs, Checklist, Version, And Verification

Metadata:

```json
{
  "phase": "3",
  "task_id": "101.3.1",
  "category": "validation",
  "workstream": "docs-version-verify",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "README.md",
    "docs/README.md",
    "docs/agentmemory-to-byomem-dashboard-checklist.md",
    "docs/byomem-runtime-operations-runbook.md",
    "package.json",
    "package-lock.json",
    "ts/packages/runtime/package.json",
    "ts/packages/runtime/src/version.ts"
  ],
  "blocked_by": [
    "101.2.1",
    "101.2.2"
  ],
  "acceptance_criteria": [
    "Docs explain interactive served refresh, auto-refresh bounds, lifecycle policy display, and read-only limits.",
    "Checklist marks planned/implemented items accurately.",
    "Version files are aligned after code changes.",
    "Focused tests, dashboard/runtime regressions, build, diff check, file-search scan, and native graph update pass."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-dashboard-runtime-base.test.ts",
    "npm test -- ts/packages/runtime/tests/sprint-84-doctor.test.ts ts/packages/runtime/tests/sprint-81-status-command.test.ts ts/packages/runtime/tests/sprint-96-cleanup-apply.test.ts",
    "npm run build",
    "git diff --check"
  ]
}
```

## Verification Plan

- `npm test -- ts/packages/runtime/tests/sprint-101-dashboard-refresh-contract.test.ts ts/packages/runtime/tests/sprint-101-served-refresh-api.test.ts ts/packages/runtime/tests/sprint-101-lifecycle-policy-model.test.ts ts/packages/runtime/tests/sprint-101-read-only-boundary.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-100-runtime-session-identity.test.ts ts/packages/runtime/tests/sprint-100-active-context-model.test.ts ts/packages/runtime/tests/sprint-100-served-switcher.test.ts ts/packages/runtime/tests/sprint-100-read-only-boundary.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-98-dashboard-serve.test.ts ts/packages/runtime/tests/sprint-99-read-only-boundary.test.ts ts/packages/runtime/tests/sprint-99-dashboard-runtime-base.test.ts`
- `npm test -- ts/packages/runtime/tests/sprint-84-doctor.test.ts ts/packages/runtime/tests/sprint-81-status-command.test.ts ts/packages/runtime/tests/sprint-96-cleanup-apply.test.ts`
- `npm run build`
- `git diff --check`
- BYOMem file-search scan for this repo after code changes.
- BYOMem native-source graph update for this repo after code changes.
