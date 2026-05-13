# BYOMem MCP Process Isolation

BYOMem now supports split MCP servers so file-search memory pressure is isolated from memory and graph tools.

## Recommended Codex Config

Use separate MCP server entries for each failure domain:

```toml
[mcp_servers.byomem_memory]
command = "node"
args = ["/Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/mcp/memory.js"]

[mcp_servers.byomem_graph]
command = "node"
args = ["/Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/mcp/graph.js"]

[mcp_servers.byomem_file_search]
command = "node"
args = ["/Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/mcp/file-search.js"]
```

The legacy all-in-one operations server remains available for compatibility:

```toml
[mcp_servers.byomem_operations]
command = "node"
args = ["/Users/ericsmith/Documents/byomem/ts/packages/runtime/dist/mcp/operations.js"]
```

Prefer the split servers for normal Codex use. The compatibility operations server emits a startup warning and should not be treated as the default file-search path.

## Runtime Verification

Every BYOMem MCP server exposes the read-only `byomem_runtime_info` tool. Harnesses should call this structured JSON tool to verify the running runtime, server domain, protocol version, build source root, and feature flags such as `split-mcp-servers`, `file-search-worker`, and `byomem-runtime-info`. The older bootstrap `version` tool remains available for compatibility, but it is a human-readable string and should not be used for feature detection.

## Failure Domains

- `memory.js`: memory status, search, store, and prune.
- `graph.js`: graph status, query, explain, path, and update.
- `file-search.js`: file-search scan, search, related search, semantic refresh, registry, and polling controls.

The file-search MCP server routes tool calls through a bounded child process. If the worker exits, times out, returns malformed JSON, or exceeds output bounds, the MCP parent returns a structured failure payload and keeps stdio alive.

## Worker Controls

Environment variables:

- `BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS`: worker hard timeout. Default: `30000`.
- `BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB`: worker V8 heap limit. Default: `256`.
- `BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY`: max in-flight file-search worker processes per MCP parent. Default: `1`.
- `BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH`: queued worker calls before structured backpressure. Default: `8`.
- `BYOMEM_FILE_SEARCH_WORKER_PATH`: override worker entrypoint, mainly for tests.
- `BYOMEM_FILE_SEARCH_DIRECT_STORE_CACHE_MAX`: max process-local direct file-search stores. Default: `2`.
- `BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB`: optional hot-index hydration budget. When exceeded, vector hydration is skipped and BM25 remains available.

Structured worker failures include safe operational fields such as kind, exit code, signal, retryability, timeout, memory limit, and recovery hint. Raw worker stderr/stdout and indexed chunk content are not returned to MCP clients.

## Degraded Search

When hot-index memory budget is exceeded, semantic vectors are skipped for that hydration attempt. BM25 search remains available. Hybrid and semantic payloads expose degradation metadata through the semantic diagnostics where available.

## Operator Guidance

If file-search returns a worker failure:

1. Retry the file-search operation.
2. Lower concurrency or narrow the query/project if failures repeat.
3. Raise `BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB` only if the machine has enough memory.
4. Set `BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB` to force BM25 fallback before worker heap pressure reaches the process limit.
5. Keep memory and graph MCP servers split so file-search failures do not close those transports.
