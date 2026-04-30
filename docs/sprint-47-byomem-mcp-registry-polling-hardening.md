# BYOMem MCP Registry / Polling Hardening

This is the Sprint 47 hardening step for the BYOMem MCP rollout.

Purpose:
- finalize project registry and project-identity handling on the MCP surface
- harden polling/status behavior so it stays predictable and read-only where intended
- document the final adapter split and the remaining edge cases around project resolution

Build first:

```bash
npm run build
```

Run the hardened MCP server:

```bash
node <REPO_ROOT>/ts/packages/runtime/dist/mcp/operations.js
```

Hermes config example:

```yaml
mcp_servers:
  byomem-operations:
    command: "node"
    args: ["<REPO_ROOT>/ts/packages/runtime/dist/mcp/operations.js"]
```

What Sprint 47 adds:
- registry/project-identity behavior for locating the active target project
- polling/status hardening to avoid accidental writes or noisy refresh behavior
- parity tests to keep Pi and MCP behavior aligned
- docs/examples that show the final rollout shape

Edge cases:
- `baseDir` controls runtime storage, not the target project identity
- active-project resolution is the source of truth when a target project is omitted
- status and polling calls should stay safe on no-scan paths and empty or ambiguous project state

Notes:
- This sprint builds on Sprint 46; the runtime entrypoint stays the same.
- Use `<REPO_ROOT>` in docs and configs instead of machine-specific absolute paths.
- See [Sprint 46 — BYOMem mutation-capable MCP server](./sprint-46-byomem-mcp-mutations.md) for the write-path surface that this sprint hardens.
- See [BYOMem MCP rollout roadmap](./byomem-mcp-rollout-roadmap.md) for the sprint sequence and rollout context.

Verification:
- targeted registry, polling, and parity regressions pass
- live Hermes discovery and tool calls succeed
- the build stays green
