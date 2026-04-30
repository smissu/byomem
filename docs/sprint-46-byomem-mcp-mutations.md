# BYOMem Mutation-capable MCP Server

This is the Sprint 46 BYOMem MCP step for write-path and operational actions.

Purpose:
- expose the first mutation-capable BYOMem server over stdio
- keep Hermes on the same shared runtime core used by the read-only server
- keep adapter wiring separate from the Pi extension and from the CLI
- keep the tool surface small and deterministic

Build first:

```bash
npm run build
```

Run the mutation-capable server:

```bash
node <REPO_ROOT>/ts/packages/runtime/dist/mcp/mutations.js
```

Hermes config example:

```yaml
mcp_servers:
  byomem-mcp-mutations:
    command: "node"
    args: ["<REPO_ROOT>/ts/packages/runtime/dist/mcp/mutations.js"]
```

Available tools:
- `status` — runtime snapshot for post-mutation verification
- `search` — read-only search for before/after checks
- `store` — persist or update a BYOMem record
- `prune` — remove a record using the shared write-intent contract
- `scan` — trigger a manual file-search scan for a target project
- `refresh` — refresh semantic embeddings for a target project

Notes:
- `status` and `search` come from the read-only MCP layer.
- `scan` and `refresh` accept an optional `baseDir`; if omitted, they default to the active project resolved from the current process context.

Deferred to Sprint 47:
- project registry tools
- polling controls
- any broader hardening or lifecycle surface beyond the Sprint 46 write path

Notes:
- This server should stay stdio-based and repo-local.
- Use `<REPO_ROOT>` in docs and Hermes configs instead of absolute machine paths.
- `BYOMEM_RUNTIME_BASE_DIR` controls runtime storage only; it does not redefine the target project.
- Keep mutation tools and read-only verification tools together so Hermes can validate the result of a write immediately.
