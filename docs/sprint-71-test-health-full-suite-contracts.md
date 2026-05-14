# Sprint 71 - Full-Suite Test Health Contracts

## Objective

Restore full-suite confidence after dependency security updates by aligning stale tests with current BYOMem runtime contracts and removing a session-capture test path that can depend on live generation timing.

## Success Criteria

- MCP bootstrap tests and docs include the intentional `byomem_runtime_info` tool.
- Hot-index runtime tests distinguish side-effect-free status calls from search paths that hydrate indexed data.
- Unscanned status/search surfaces report a cold hot index with `source: none` and no indexed records.
- Session-capture sensitive-field coverage does not perform a live generation request.
- Focused failing suites, build, Gitleaks, npm audit, and full test suite pass.

## Phase 0: RED Baseline

Metadata:

```json
{
  "phase": "0",
  "task_id": "71.0.1",
  "category": "test",
  "workstream": "baseline",
  "agent_role": "default",
  "acceptance_criteria": [
    "Focused failing suites reproduce before implementation.",
    "Failures are classified by contract drift versus runtime behavior."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-44-mcp-bootstrap.test.ts ts/packages/runtime/tests/sprint-56-file-search-hot-index-benchmark.test.ts ts/packages/runtime/tests/sprint-56-file-search-hot-index-runtime-surfaces.test.ts ts/packages/runtime/tests/sprint-58-file-search-runtime-surfaces.test.ts ts/packages/runtime/tests/session-capture.test.ts --run"
  ]
}
```

Status: completed. The RED baseline reproduced bootstrap, hot-index benchmark/runtime, and unscanned hot-index assertion failures. `session-capture.test.ts` passed focused but includes a live generation path in the sensitive-field case.

## Phase 1: Bootstrap MCP Contract

Metadata:

```json
{
  "phase": "1",
  "task_id": "71.1.1",
  "category": "impl",
  "workstream": "mcp-bootstrap",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-44-mcp-bootstrap.test.ts",
    "docs/byomem-mcp-bootstrap.md"
  ],
  "blocked_by": ["71.0.1"],
  "acceptance_criteria": [
    "The bootstrap test expects byomem_runtime_info, ping, and version.",
    "The test calls byomem_runtime_info and verifies bootstrap domain metadata.",
    "Bootstrap docs list the runtime-info tool."
  ]
}
```

Status: completed. The bootstrap stdio smoke test now verifies `byomem_runtime_info` as a structured runtime-info tool, and the bootstrap docs list it with `ping` and `version`.

## Phase 2: Hot-Index Contract Alignment

Metadata:

```json
{
  "phase": "2",
  "task_id": "71.2.1",
  "category": "impl",
  "workstream": "file-search-hot-index",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-56-file-search-hot-index-benchmark.test.ts",
    "ts/packages/runtime/tests/sprint-56-file-search-hot-index-runtime-surfaces.test.ts",
    "ts/packages/runtime/tests/sprint-58-file-search-runtime-surfaces.test.ts"
  ],
  "blocked_by": ["71.0.1"],
  "acceptance_criteria": [
    "Benchmark hydrates or searches before asserting ready hot-index state.",
    "Pi scan/status assertions allow scan diagnostics to remain cold while search diagnostics become ready after indexed search.",
    "Unscanned status/search assertions expect cold/source none/revision 0 without indexed records."
  ]
}
```

Status: completed. Sprint 56/58 tests now assert non-hydrating status diagnostics separately from search-triggered hot-index hydration.

## Phase 3: Session-Capture Determinism

Metadata:

```json
{
  "phase": "3",
  "task_id": "71.3.1",
  "category": "impl",
  "workstream": "session-capture",
  "agent_role": "worker",
  "owned_paths": [
    "ts/packages/runtime/tests/session-capture.test.ts"
  ],
  "blocked_by": ["71.0.1"],
  "acceptance_criteria": [
    "The sensitive support-field test remains below the rollup threshold.",
    "The test asserts no checkpoint and no rollup record are persisted.",
    "The test cannot call live generation."
  ]
}
```

Status: completed. The sensitive support-field case now remains below the rollup threshold and asserts that neither checkpoint nor rollup records are persisted.

## Phase 4: Verification And PR

Metadata:

```json
{
  "phase": "4",
  "task_id": "71.4.1",
  "category": "verification",
  "workstream": "integration",
  "agent_role": "default",
  "blocked_by": ["71.1.1", "71.2.1", "71.3.1"],
  "acceptance_criteria": [
    "Focused failing suites pass.",
    "Full npm test suite passes.",
    "npm run build passes.",
    "npm audit and Gitleaks pass.",
    "BYOMem file-search and graph indexes are refreshed after changes.",
    "A GitHub PR is opened from the test-health branch."
  ]
}
```

Status: completed locally. Focused tests, full test suite, build, npm audit, and Gitleaks passed before PR creation.
