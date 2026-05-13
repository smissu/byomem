# byomem — TS-native runtime canonical

This repository now treats the TypeScript runtime/observer path as canonical.

- Active runtime/observer code: `ts/**`, `queue-watch.sh`, `queue-observe`
- Legacy Python implementation has been moved to sibling repo: `/Users/ericsmith/Documents/byomem-python`
- Keep Python surfaces out of this repo unless they are explicit compatibility docs or references.

## Hermes / BYOMem workflow

Future Hermes sessions in this repo should:
- check project memory first for repo-local decisions and prior durable facts
- use `byomem_file_search` for exact passages, indexed evidence, and semantic matches
- use `byomem_graph_query`, `byomem_graph_explain`, and `byomem_graph_path` for architecture or cross-module relationship questions
- run `byomem_graph_update` after modifying code files when graph context should be refreshed
- run a BYOMem file-search scan after modifying code files

Historical compatibility docs may remain here, but implementation work should target the TS-native runtime.

## MCP process isolation

Use split MCP servers for normal Codex/Hermes operation:

- `ts/packages/runtime/dist/mcp/memory.js`
- `ts/packages/runtime/dist/mcp/graph.js`
- `ts/packages/runtime/dist/mcp/file-search.js`

The legacy `operations.js` entrypoint remains available for compatibility, but split servers are preferred so file-search worker failures cannot close memory or graph MCP transports. See [docs/byomem-mcp-process-isolation.md](docs/byomem-mcp-process-isolation.md).
