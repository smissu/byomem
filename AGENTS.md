# BYOMem Repo Guidance

## Hermes-native graph maintenance
- After modifying code files in this session, run BYOMem graph update with `native-source` mode for this repo to keep the graph current.
- After modifying code files in this session, run a BYOMem file-search scan for this repo to keep indexed source passages current.
- Use `graphify-out/graph.json` only as a one-time migration or repair import source, not as the ongoing graph refresh path.
- Use `byomem-project-repair` if graph state is empty, stale, unexpectedly sparse, or still depends on a legacy graphify export.
- If you capture a durable repo decision, store it as concise project memory only after verifying it is stable and worth keeping.

## Versioning policy
- Update the BYOMem app/runtime version whenever making code changes, fixes, or improvements.
- Keep `package.json`, `ts/packages/runtime/package.json`, `package-lock.json`, and `ts/packages/runtime/src/version.ts` aligned.
- MCP server version constants should derive from `BYOMEM_RUNTIME_VERSION` so `byomem_runtime_info` reports a reliable version across memory, graph, file-search, operations, readonly, and bootstrap surfaces.

## BYOMem extension policy
- This repo should use the global Pi BYOMem extension from `~/.pi/agent/extensions/byomem/` when available.
- Do not keep a second active BYOMem runtime under `.pi/extensions/`, because Pi auto-discovers both project and global extensions and duplicate BYOMem tools/hooks can conflict.
- Keep repo-local BYOMem implementation code in canonical shared source files, not as a second auto-loaded project extension runtime.
