# BYOMem Read-Only MCP Server

This is the Sprint 45 read-only MCP step for BYOMem.

Purpose:
- expose a minimal inspection/search surface over stdio
- reuse the shared read-only BYOMem core for status and native-store search
- keep the Pi adapter untouched while Hermes gets a native MCP read path

Build first:

```bash
npm run build
```

Run the read-only server:

```bash
node <REPO_ROOT>/ts/packages/runtime/dist/mcp/readonly.js
```

Hermes config example:

```yaml
mcp_servers:
  byomem-readonly:
    command: "node"
    args: ["<REPO_ROOT>/ts/packages/runtime/dist/mcp/readonly.js"]
```

Available tools:
- `status` — returns the read-only runtime snapshot
- `search` — searches the BYOMem native store without writing

Notes:
- The server is read-only.
- It does not register or refresh file-search state.
- It is intended as the first practical MCP BYOMem inspection surface after the transport-only bootstrap.
