# Initial Project Review — BYOMem

Date: 2026-04-30

## Executive summary
BYOMem is a TypeScript-native memory, file-search, and runtime-observer system. The repo has explicitly moved away from Python as the active implementation path: the TS runtime is canonical, and legacy Python surfaces are kept only as compatibility references or external history.

The project’s core value is not just storing memory, but making memory and file-search capabilities available as durable runtime tools that can be called from Hermes/Pi sessions and project workflows.

## What the project appears to be
- A TS runtime for native memory storage and retrieval.
- A file-search/indexing system with global runtime storage and per-project logical partitioning.
- A session/queue processing pipeline that captures events, writes memory, indexes search data, and exposes runtime status.
- A Hermes/Pi-facing tool layer that registers direct tools for memory, file search, scanning, registry, and polling.

## Canonical runtime direction
The repo clearly states that the TypeScript runtime/observer path is canonical.

Observed canonical surfaces:
- `ts/**`
- `queue-watch.sh`
- `queue-observe`

Legacy Python is explicitly out of the active implementation path.

## Main architecture themes
### 1) Native memory store and queue pipeline
The runtime uses a queue-based flow for memory writes and session processing. The pipeline docs describe:
- fast hook/entry capture
- background worker processing
- summarize / embed / write phases
- optional source-code reindexing

This suggests BYOMem is designed for asynchronous, durable knowledge extraction rather than only direct CRUD over a flat store.

### 2) File-search as a first-class subsystem
File search is not an add-on; it has its own DB, registry, scanner status, project identity, and polling support.

Important characteristics:
- global runtime storage by default
- logical partitioning by project key
- explicit registration semantics
- read-only status operations separate from scan operations
- manual scan and session-owned polling support

### 3) Hermes/Pi tool integration is direct, not just CLI-based
The runtime exposes multiple Pi tools via `pi.registerTool(...)`. This makes the features discoverable inside Hermes sessions without shelling out through the CLI.

Current direct tools visible in `ts/packages/runtime/src/pi-extension.ts` include:
- `byomem_runtime_status`
- `byomem_search`
- `byomem_store`
- `byomem_prune`
- `byomem_file_search`
- `byomem_file_search_semantic_refresh`
- `byomem_file_search_status`
- `byomem_file_search_scan`
- `byomem_file_search_polling_status`
- `byomem_file_search_polling_enable`
- `byomem_file_search_polling_disable`
- `byomem_file_search_project_register`
- `byomem_file_search_project_list`
- `byomem_file_search_project_unregister`

## How the tools can be used in Hermes
### Memory tools
These are the core Hermes-facing tools for durable project knowledge:
- `byomem_search` for querying native memory
- `byomem_store` for writing records
- `byomem_prune` for removing records
- `byomem_runtime_status` for validating the runtime state

These tools return JSON payloads and are intended to be callable directly from the agent.

### File-search tools
These are the primary project-workflow tools for Hermes:
- `byomem_file_search` for indexed file lookup
- `byomem_file_search_status` for scanner/project status without scanning
- `byomem_file_search_scan` for explicit scans
- `byomem_file_search_semantic_refresh` for embedding refresh without scanning
- registry tools for opt-in project management
- polling tools for session-owned active-project polling

Notable behavior:
- `baseDir` is the target project root, not the DB storage location.
- When `baseDir` is omitted, the active project is resolved from the current runtime context.
- File-search status is read-only and should not implicitly scan.
- `byomem_file_search_scan` supports explicit async runtime-local mode via `async: true` or `wait: false`.

## Integration model in Hermes
The most likely Hermes integration pattern is:
1. Load the Hermes-facing BYOMem extension.
2. Use direct tools in session rather than CLI wrappers for routine operations.
3. Use the runtime status and file-search status tools to verify state before assuming the index is fresh.
4. Register projects explicitly when automation/polling is desired.
5. Use the CLI only as a fallback/debug surface.

This matches the docs’ stated intent that direct tools are more sustainable across context resets than hidden watchers or ad hoc shell commands.

## Build and verification signals
The repo uses a TypeScript toolchain:
- root `package.json` uses `vitest` and `tsc`
- runtime package builds to `dist/`
- `queue-watch.sh` is a CLI wrapper around the TS runtime `queue-observe` command

The working tree is currently clean, which is a good baseline for follow-up review or implementation.

## Initial observations and likely risks
- The project has a fairly rich tool surface; contract drift between docs, tests, and the Pi extension is a real risk.
- Several tool names and behaviors are sprint-driven, so some docs likely describe intended behavior rather than always-shipped behavior.
- File-search uses a global storage model with explicit project scoping, so Hermes users must be careful not to confuse storage location with project target.
- Async scan support is runtime-local, not durable, so agents should not assume scan jobs survive process restarts.

## Good follow-up review areas
1. Confirm which tool names are actually exposed in the installed Hermes/Pi environment.
2. Verify that the docs match the current `pi-extension.ts` contracts.
3. Inspect the current tests around file-search registration, status, scan, and polling.
4. Check whether any Hermes skill should be added or updated to teach the recommended tool usage pattern.
5. Review whether the current direct tools surface enough status to make project workflows reliable inside Hermes.

## Bottom line
BYOMem looks like a TS-native agent support layer for durable memory plus project file intelligence, with Hermes/Pi integration as a first-class interface. The highest-value integration path is direct tool usage inside Hermes sessions, backed by explicit project registration and runtime status checks rather than hidden automation.
