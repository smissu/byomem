# BYOMem MCP Bootstrap

This is the Sprint 44 transport-only MCP bootstrap for BYOMem.

Purpose:
- prove Hermes can discover and call a trivial external MCP server over stdio
- keep this separate from the Pi adapter and from BYOMem domain logic

Build first:

```bash
npm run build
```

Run the bootstrap server:

```bash
node <REPO_ROOT>/ts/packages/runtime/dist/mcp/bootstrap.js
```

Hermes config example:

```yaml
mcp_servers:
  byomem-bootstrap:
    command: "node"
    args: ["<REPO_ROOT>/ts/packages/runtime/dist/mcp/bootstrap.js"]
```

Available tools:
- `byomem_runtime_info` — returns structured BYOMem runtime, build, feature, and bootstrap server metadata
- `ping` — returns `pong`
- `version` — returns the bootstrap server name and version

Notes:
- This server is transport-only.
- It does not read or write BYOMem data.
- It exists only as the first MCP discovery smoke test for the rollout roadmap.
