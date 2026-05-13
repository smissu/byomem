# Sprint 70: MCP Process Isolation And File-Search Memory Guards

> Use `sprint-implementation` to execute this plan task-by-task after review.
> This plan is eKanban-ready, but the current Codex session does not expose an eKanban MCP tool.

## Implementation Status

Planning artifact only. No implementation has started.

## Objective

Fix BYOMem MCP `Transport closed` failures caused by file-search hot-index memory pressure by splitting MCP failure domains, moving heap-heavy file-search execution behind bounded worker processes, and adding explicit memory guards around direct file-search store and hot-index hydration.

This sprint implements the previously identified fixes:

1. Split MCP servers by failure domain.
2. Run file-search work in restartable bounded worker processes.
3. Cap long-lived direct file-search caches and guard hot-index hydration.

## Current Evidence

- Codex logs on 2026-05-13 showed BYOMem MCP stderr: `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.
- Codex subsequently reported `Transport closed` for unrelated BYOMem operations because the shared stdio MCP process had died.
- Current global Codex config points BYOMem MCP servers at repo dist entrypoints:
  - `ts/packages/runtime/dist/mcp/readonly.js`
  - `ts/packages/runtime/dist/mcp/operations.js`
- `operations-tools.ts` currently keeps direct file-search stores in a module-level `Map`, keyed by runtime/baseDir, with idle cleanup.
- `file-search-index.ts` can hydrate every indexed chunk and ready embedding vector into one in-process hot index.
- The file-search SQLite runtime is large enough that multiple active projects/sessions can push the long-lived Node MCP process near heap limits.

## Success Criteria

- Dedicated MCP entrypoints exist for memory, graph, and file-search tool groups.
- Default/recommended Codex config uses split MCP servers so file-search crashes cannot kill memory or graph tools.
- A file-search worker process can crash, timeout, or exceed memory limits without closing the MCP stdio transport.
- File-search MCP returns a structured failure payload for worker failures, including exit signal/code and recovery guidance.
- File-search worker lifecycle is explicit: process model, heap limit, timeout, concurrency, cleanup, and retry/backoff policy are specified before routing MCP calls through workers.
- File-search SQLite write paths have a single-writer/backpressure contract that prevents worker fan-out from causing lock contention or unsafe concurrent mutation.
- Direct file-search store caching is bounded by project count and memory policy, with deterministic close/invalidation behavior.
- Direct-store and hot-index memory guards apply to the process that owns the allocation, with parent MCP process RSS remaining bounded across repeated file-search calls and worker failures.
- Hot-index hydration honors configurable memory limits and degrades safely instead of hydrating unbounded rows/vectors.
- Legacy all-in-one `operations` remains available as a compatibility surface but warns, documents migration, and does not silently keep the unsafe unbounded file-search path.
- Worker failure tests use deterministic failure injection rather than relying on large-data real OOM.
- Regression tests prove graph and memory MCP calls remain responsive after a simulated file-search worker failure.
- Build output is verified before docs are finalized, and docs are updated so `~/.codex/config.toml` can point at the confirmed split dist entrypoints.

## Out Of Scope

- Replacing SQLite as the durable file-search source of truth.
- Removing the hot index entirely.
- Introducing ANN/vector database infrastructure.
- Changing ranking semantics except when a documented memory guard intentionally degrades semantic/hybrid search.
- Mutating a user's global `~/.codex/config.toml` automatically.

## Shared Kernel

These files are shared across workstreams and must be handled serially before independent implementation:

- `ts/packages/runtime/src/mcp/operations-tools.ts`
- `ts/packages/runtime/src/mcp/operations-server.ts`
- `ts/packages/runtime/src/mcp/readonly-tools.ts`
- `ts/packages/runtime/src/mcp/index.ts`
- `ts/packages/runtime/src/file-search-index.ts`
- `ts/packages/runtime/src/file-search-query.ts`
- `ts/packages/runtime/src/cli.ts`
- `package.json`
- `ts/packages/runtime/package.json`

Expected new files:

- `ts/packages/runtime/src/mcp/memory-server.ts`
- `ts/packages/runtime/src/mcp/graph-server.ts`
- `ts/packages/runtime/src/mcp/file-search-server.ts`
- `ts/packages/runtime/src/mcp/memory-tools.ts`
- `ts/packages/runtime/src/mcp/graph-tools.ts`
- `ts/packages/runtime/src/mcp/file-search-tools.ts`
- `ts/packages/runtime/src/file-search-worker.ts`
- `ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts`
- `ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts`
- `ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts`
- `ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts`
- `docs/byomem-mcp-process-isolation.md`

## Workstreams

- `mcp-topology`: split MCP entrypoints and tool registration.
- `worker-isolation`: bounded file-search worker process and structured failure handling.
- `memory-guards`: direct store LRU/close policy and hot-index memory guard behavior.
- `worker-contracts`: worker lifecycle, SQLite single-writer/backpressure, and failure payload safety contracts.
- `config-docs`: package scripts, dist build, Codex config guidance, and runbook.
- `verification`: failure-domain smoke tests, build checks, and review.

## Tool-To-Domain Mapping

Implementation must add and validate an explicit mapping for every currently exposed MCP tool before splitting registration:

- `memory`: memory status/search/store/prune and memory-specific maintenance tools.
- `graph`: byomem graph status/query/explain/path/update tools.
- `file-search`: file-search scan/search/refresh/registry/polling and related-chunk tools.
- `legacy/compatibility`: all-in-one operations aliases kept for migration, with warnings and bounded file-search behavior.

The split servers must be least-privilege: memory must not expose graph-update or file-search tools, graph must not expose memory mutation or file-search tools, and file-search must not expose memory mutation or graph-update tools.

## Phase 0: RED Tests

### Task 70.0.1: RED Split MCP Tool Topology

Metadata:

```json
{
  "phase": "0",
  "task_id": "70.0.1",
  "category": "test",
  "workstream": "mcp-topology",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "A memory MCP entrypoint exposes status/search/store/prune and does not expose file-search or graph-update tools.",
    "A graph MCP entrypoint exposes byomem_graph_status/query/explain/path/update and does not expose file-search tools.",
    "A file-search MCP entrypoint exposes file-search scan/search/refresh/registry/polling tools and does not expose memory mutation or graph-update tools.",
    "The test fixture asserts an explicit tool-to-domain mapping for every current MCP tool.",
    "Current implementation fails because only readonly and all-in-one operations entrypoints exist."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts"
  ]
}
```

### Task 70.0.2: RED File-Search Worker Failure Isolation

Metadata:

```json
{
  "phase": "0",
  "task_id": "70.0.2",
  "category": "test",
  "workstream": "worker-isolation",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Simulated worker nonzero exit, signal termination, timeout, malformed JSON, oversized stderr/stdout, and synthetic memory-budget failures return structured MCP error payloads instead of closing stdio.",
    "Structured failure payloads include safe operational fields such as kind, exitCode, signal, timeoutMs, memoryLimitMb, retryable, and recoveryHint.",
    "Structured failure payloads never include raw stderr/stdout, chunk text, embeddings, raw query content, or full stack traces by default.",
    "After the simulated file-search worker failure, the file-search MCP server can still answer status/list-tools.",
    "A separate graph MCP process remains responsive after the file-search worker failure.",
    "Current implementation fails because file-search work runs inside the shared operations MCP process."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ]
}
```

### Task 70.0.3: RED File-Search Memory Guard Contracts

Metadata:

```json
{
  "phase": "0",
  "task_id": "70.0.3",
  "category": "test",
  "workstream": "memory-guards",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Direct file-search store cache enforces a configurable max project count and closes evicted stores in whichever process owns the direct-store allocation.",
    "Idle cleanup invalidates hot indexes and closes SQLite handles deterministically.",
    "Hot-index hydration refuses or degrades semantic vector hydration when estimated memory exceeds a configured budget.",
    "Hybrid/semantic searches report memory-guard fallback metadata when vectors are not hydrated.",
    "Parent MCP process RSS remains bounded across repeated file-search calls and worker failures.",
    "Current implementation fails because cache size and hot-index hydration are unbounded by memory policy."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts"
  ]
}
```

### Task 70.0.4: RED Worker Contracts And Legacy Safety

Metadata:

```json
{
  "phase": "0",
  "task_id": "70.0.4",
  "category": "test",
  "workstream": "worker-contracts",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts"
  ],
  "blocked_by": [],
  "acceptance_criteria": [
    "Concurrent same-project mutating file-search operations are serialized or receive structured backpressure instead of producing unhandled SQLite busy/locked failures.",
    "Long-running scan/refresh/polling operations have a documented concurrency lane that cannot starve simple query operations without structured backpressure.",
    "Legacy all-in-one operations startup emits a migration warning or equivalent visible compatibility notice.",
    "Legacy all-in-one operations file-search behavior uses the same bounded worker/cache safety path or a documented bounded compatibility policy.",
    "Current implementation fails because worker lifecycle, SQLite write ownership, and legacy compatibility safety are implicit."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts"
  ]
}
```

## Phase 1: MCP Topology Split

### Task 70.1.1: Extract Tool Registration By Failure Domain

Metadata:

```json
{
  "phase": "1",
  "task_id": "70.1.1",
  "category": "impl",
  "workstream": "mcp-topology",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/memory-tools.ts",
    "ts/packages/runtime/src/mcp/graph-tools.ts",
    "ts/packages/runtime/src/mcp/file-search-tools.ts",
    "ts/packages/runtime/src/mcp/operations-tools.ts",
    "ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts"
  ],
  "blocked_by": [
    "70.0.1"
  ],
  "acceptance_criteria": [
    "Memory, graph, and file-search tool registration can be composed independently.",
    "An explicit tool-to-domain mapping is documented in tests or source and covers every currently exposed MCP tool.",
    "Existing all-in-one operations registration remains available as a compatibility surface.",
    "Split registration does not duplicate tool names inside one server instance.",
    "Least-privilege split servers enforce the mapping: no cross-domain file-search, memory mutation, or graph-update leakage.",
    "Existing Sprint 45/47/63 MCP tests remain compatible or are intentionally updated."
  ]
}
```

### Task 70.1.2: Add Split MCP Server Entrypoints

Metadata:

```json
{
  "phase": "1",
  "task_id": "70.1.2",
  "category": "impl",
  "workstream": "mcp-topology",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/memory-server.ts",
    "ts/packages/runtime/src/mcp/graph-server.ts",
    "ts/packages/runtime/src/mcp/file-search-server.ts",
    "ts/packages/runtime/src/mcp/index.ts",
    "package.json",
    "ts/packages/runtime/package.json",
    "ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts"
  ],
  "blocked_by": [
    "70.1.1"
  ],
  "acceptance_criteria": [
    "Dist build emits memory, graph, and file-search MCP entrypoint files.",
    "Package scripts expose the split servers with clear names.",
    "All split servers use stdio and support listTools through the real MCP client.",
    "The legacy operations server stays available but is no longer the recommended default for file search."
  ]
}
```

## Phase 2: File-Search Worker Isolation

### Task 70.2.0: Define File-Search Worker Lifecycle And SQLite Contract

Metadata:

```json
{
  "phase": "2",
  "task_id": "70.2.0",
  "category": "design",
  "workstream": "worker-contracts",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "docs/byomem-mcp-process-isolation.md",
    "ts/packages/runtime/src/file-search-worker.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts"
  ],
  "blocked_by": [
    "70.0.2",
    "70.0.3",
    "70.0.4"
  ],
  "acceptance_criteria": [
    "Worker process model is explicit and uses child-process isolation, not worker_threads, for MCP failure-domain safety.",
    "Worker lifecycle specifies per-call vs pooled behavior, max concurrent workers globally and per project, idle timeout, hard timeout, cleanup on MCP disconnect, heap limit flags, and retry/backoff policy.",
    "Config/env names exist for worker heap limit, timeout, concurrency, queue depth, direct-store cache size, and hot-index memory budget.",
    "The contract defines whether scan/refresh/register/polling write paths run in workers or through a serialized writer lane.",
    "SQLite write behavior is explicit: single-writer ownership, SQLITE_BUSY/locked timeout handling, queue/backpressure response shape, and cleanup after worker death mid-operation.",
    "Long-running scan/refresh/polling operations cannot silently starve query operations; queueing or rejection is documented and testable."
  ]
}
```

### Task 70.2.1: Add File-Search Worker Protocol

Metadata:

```json
{
  "phase": "2",
  "task_id": "70.2.1",
  "category": "impl",
  "workstream": "worker-isolation",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-worker.ts",
    "ts/packages/runtime/src/cli.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ],
  "blocked_by": [
    "70.2.0"
  ],
  "acceptance_criteria": [
    "Worker accepts JSON requests only for operations permitted by the worker lifecycle and SQLite contract.",
    "Worker writes one JSON response to stdout and uses stderr only for diagnostics.",
    "Worker process can be run with a bounded Node heap using the configured heap-limit policy.",
    "Worker response schema preserves existing DTO shapes for successful file-search operations and includes safe structured failure fields for failures.",
    "Worker stderr/stdout is bounded and sanitized before any MCP tool result is built."
  ]
}
```

### Task 70.2.2: Route File-Search MCP Through Bounded Worker

Metadata:

```json
{
  "phase": "2",
  "task_id": "70.2.2",
  "category": "impl",
  "workstream": "worker-isolation",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/file-search-tools.ts",
    "ts/packages/runtime/src/mcp/file-search-server.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ],
  "blocked_by": [
    "70.1.2",
    "70.2.1"
  ],
  "acceptance_criteria": [
    "File-search MCP tool calls spawn or reuse a bounded worker according to an explicit policy.",
    "Worker timeout, nonzero exit, signal, malformed JSON, oversized stderr/stdout, and synthetic memory-budget failures become structured tool responses.",
    "Structured tool responses include safe exit code/signal/retry/recovery fields and exclude raw worker logs or indexed content.",
    "The MCP stdio process remains alive after worker failure.",
    "A healthy subsequent call can use a fresh worker.",
    "Backpressure for saturated per-project or global worker limits returns a structured failure/deferred response instead of blocking indefinitely."
  ]
}
```

## Phase 3: Memory Guards

### Task 70.3.1: Bound Direct File-Search Store Cache

Metadata:

```json
{
  "phase": "3",
  "task_id": "70.3.1",
  "category": "impl",
  "workstream": "memory-guards",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/file-search-tools.ts",
    "ts/packages/runtime/src/file-search-worker.ts",
    "ts/packages/runtime/src/pi-extension.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts"
  ],
  "blocked_by": [
    "70.0.3",
    "70.2.0"
  ],
  "acceptance_criteria": [
    "Direct file-search store cache max size is configurable and defaults to a conservative value in the process that owns the allocation.",
    "Evicted stores close SQLite handles and invalidate cached FileSearchIndex snapshots.",
    "Pi/direct runtime gets the same cache safety policy or a documented equivalent.",
    "File-search worker/direct runtime exposes parent-vs-worker ownership clearly in diagnostics.",
    "Diagnostics expose cache size and eviction count."
  ]
}
```

### Task 70.3.2: Add Hot-Index Hydration Memory Budget

Metadata:

```json
{
  "phase": "3",
  "task_id": "70.3.2",
  "category": "impl",
  "workstream": "memory-guards",
  "agent_role": "worker",
  "reasoning_effort": "high",
  "owned_paths": [
    "ts/packages/runtime/src/file-search-index.ts",
    "ts/packages/runtime/src/file-search-query.ts",
    "ts/packages/runtime/src/file-search-worker.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts"
  ],
  "blocked_by": [
    "70.2.0"
  ],
  "acceptance_criteria": [
    "Hot-index hydration estimates row and vector memory before loading all ready embeddings.",
    "Configured budget breach skips vector hydration or returns a clear memory-guard fallback state.",
    "BM25-only search remains available when semantic vectors are skipped.",
    "Hybrid/semantic search payloads include diagnostics explaining degraded behavior.",
    "The memory budget is enforced inside the worker when the worker owns hot-index hydration.",
    "Parent MCP process memory remains stable across repeated budget-breach and worker-restart scenarios."
  ]
}
```

### Task 70.3.3: Harden Legacy Operations File-Search Compatibility

Metadata:

```json
{
  "phase": "3",
  "task_id": "70.3.3",
  "category": "impl",
  "workstream": "worker-contracts",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/src/mcp/operations-server.ts",
    "ts/packages/runtime/src/mcp/operations-tools.ts",
    "ts/packages/runtime/src/mcp/file-search-tools.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts",
    "ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ],
  "blocked_by": [
    "70.2.2",
    "70.3.1"
  ],
  "acceptance_criteria": [
    "Legacy all-in-one operations startup emits a clear compatibility warning that split MCP servers are recommended for isolation.",
    "Legacy operations file-search calls use the same bounded worker path where practical or a bounded documented compatibility policy.",
    "Legacy direct file-search stores are capped and evicted with deterministic SQLite handle close behavior.",
    "Existing operations users retain compatibility for supported non-file-search tools.",
    "Tests prove legacy operations cannot keep unbounded file-search stores alive silently."
  ]
}
```

## Phase 4: Config, Docs, And Migration

### Task 70.4.1: Build And Dist Parity

Metadata:

```json
{
  "phase": "4",
  "task_id": "70.4.1",
  "category": "verification",
  "workstream": "config-docs",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/dist/**",
    "package.json",
    "ts/packages/runtime/package.json"
  ],
  "blocked_by": [
    "70.1.2",
    "70.3.3",
    "70.3.1",
    "70.3.2"
  ],
  "acceptance_criteria": [
    "Build emits split MCP dist entrypoints for memory, graph, and file-search.",
    "Package exports/bin entries expose the split servers and preserve legacy readonly/operations compatibility.",
    "Dist entrypoints pass listTools and basic startup smoke tests with real stdio MCP clients.",
    "CLI help or package scripts identify each split server clearly.",
    "No stale May 8-style dist mismatch remains after implementation."
  ],
  "commands": [
    "npm run build",
    "npm test -- ts/packages/runtime/tests/sprint-70-mcp-process-isolation.test.ts ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts ts/packages/runtime/tests/sprint-70-file-search-memory-guards.test.ts ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts"
  ]
}
```

### Task 70.4.2: Document Split MCP Deployment

Metadata:

```json
{
  "phase": "4",
  "task_id": "70.4.2",
  "category": "docs",
  "workstream": "config-docs",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "docs/byomem-mcp-process-isolation.md",
    "README.md",
    "docs/codex-hooks-reference.md"
  ],
  "blocked_by": [
    "70.4.1"
  ],
  "acceptance_criteria": [
    "Docs explain why file-search is isolated from graph and memory MCP servers.",
    "Docs provide sample `~/.codex/config.toml` blocks for the confirmed memory, graph, and file-search dist entrypoints.",
    "Docs include a compatibility note and migration warning for legacy all-in-one operations MCP.",
    "Docs include operator guidance for worker OOM, timeout, backpressure, sanitized structured failure payloads, and memory-budget degradation."
  ]
}
```

## Phase 5: Integration Verification And Review

### Task 70.5.1: Runtime Failure-Domain Smoke Test

Metadata:

```json
{
  "phase": "5",
  "task_id": "70.5.1",
  "category": "verification",
  "workstream": "verification",
  "agent_role": "worker",
  "reasoning_effort": "medium",
  "owned_paths": [
    "ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts"
  ],
  "blocked_by": [
    "70.4.2"
  ],
  "acceptance_criteria": [
    "Real stdio MCP clients can connect to memory, graph, and file-search split servers concurrently.",
    "A deterministic forced file-search worker failure does not break memory or graph client calls.",
    "A second file-search call after failure uses a fresh worker and returns a deterministic result or structured failure.",
    "No test depends on large-data real OOM; worker crashes, timeouts, malformed output, and synthetic memory-budget failures are injected deterministically.",
    "Parent MCP process RSS remains bounded during repeated worker failure/restart scenarios."
  ],
  "commands": [
    "npm test -- ts/packages/runtime/tests/sprint-70-file-search-worker-isolation.test.ts ts/packages/runtime/tests/sprint-70-file-search-worker-contracts.test.ts"
  ]
}
```

### Task 70.5.2: Sprint Review Gate

Metadata:

```json
{
  "phase": "5",
  "task_id": "70.5.2",
  "category": "review",
  "workstream": "verification",
  "agent_role": "default",
  "reasoning_effort": "high",
  "owned_paths": [],
  "blocked_by": [
    "70.5.1",
    "70.4.2"
  ],
  "acceptance_criteria": [
    "Review confirms file-search worker isolation actually protects MCP stdio transport.",
    "Review confirms worker lifecycle, SQLite single-writer/backpressure, and legacy compatibility contracts were implemented as planned.",
    "Review confirms split MCP tool groups are least-privilege and do not hide required tools.",
    "Review confirms memory guard defaults are conservative and observable.",
    "Review confirms compatibility docs are clear enough to migrate `~/.codex/config.toml` manually."
  ]
}
```

## Execution Notes

- Start by landing RED tests for all four failure/contract modes.
- Serialize Phase 1 because tool registration changes are shared kernel work.
- Do not start worker routing until `70.2.0` has frozen the process lifecycle, SQLite write ownership, failure payload, and backpressure contracts.
- Phase 2 and Phase 3 are serial unless `70.2.0` defines a narrow worker-facing interface that makes their write sets truly disjoint.
- Keep legacy `byomem-mcp-operations` available until split server config is verified in Codex.
- Do not rely on real large-data OOM as a regression mechanism; use deterministic worker failure injection and synthetic memory-budget failures.
- Do not auto-edit user global Codex config from implementation code; produce docs and sample blocks instead.
- After implementation changes code files, run BYOMem file-search scan and native graph update for this repo.
