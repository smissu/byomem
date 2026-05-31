# BYOMem Operational Polish Backlog

Source inspiration: comparison against `rohitg00/agentmemory` and the recent BYOMem MCP duplicate-process cleanup incident.

## Goal

Make BYOMem easier to operate from Codex and from the shell by adding clear status, cleanup, diagnostics, configuration, removal, health, and smoke-test surfaces. These items should reduce ambiguity when MCP servers hang, stale processes remain after a GUI exits, or a runtime install is only partially configured.

## Backlog Items

1. `byomem status`
   - Read-only summary of runtime version, configured MCP entrypoints, live BYOMem process counts, index health, graph health, and data locations.
   - First sprint because it gives users and future commands a shared diagnostic contract.

2. `byomem stop` / `byomem cleanup`
   - Safe process cleanup command with dry-run output, stale-process detection, duplicate detection, and explicit apply mode.
   - Must avoid killing unrelated Node/Codex processes.

3. Runtime state and pidfile ownership
   - Runtime-owned state directory with pidfiles, command metadata, server role, cwd, start time, and stale-state cleanup.
   - Gives status and cleanup a reliable source of truth instead of shell-process guessing.

4. `byomem doctor`
   - Diagnostic report for config, runtime version alignment, MCP startup health, database/index availability, graph readiness, and common repair suggestions.
   - Should be read-only by default with explicit fix modes later.

5. `byomem connect codex`
   - Idempotent Codex setup command for MCP config and BYOMem hook reminders.
   - Should support dry-run, backup, and status-only modes.

6. `byomem remove`
   - Idempotent uninstall/remove workflow for Codex config entries, hooks, generated runtime state, and optional data cleanup.
   - Must default to preserving user data unless explicitly requested.

7. Lightweight viewer/dashboard
   - Local status viewer for memory, file-search, graph, MCP roles, and runtime state.
   - Prefer static generated HTML or a read-only local route before introducing another daemon.

8. Session replay/import
   - Import or replay Codex transcript/session artifacts into reviewed capture candidates.
   - Keep raw transcript ingestion separate from durable memory storage.

9. Structured health endpoints/tools
   - Stable health contracts for CLI and MCP consumers, including liveness, readiness, and degraded-state diagnostics.
   - Should be machine-readable and reuse runtime status primitives.

10. One-command demo/smoke test
    - `byomem verify` or equivalent command that creates a disposable project, registers it, scans it, queries it, validates graph/file-search readiness, and cleans up.
    - Useful for releases, support, and post-install confidence checks.

## Priority Order

1. Status command
2. Cleanup/stop command
3. Runtime state and pidfiles
4. Doctor diagnostics
5. Connect Codex
6. Remove/uninstall workflow
7. Structured health
8. One-command smoke test
9. Session replay/import
10. Lightweight viewer/dashboard

The sprint sequence below keeps the original ten-item order for traceability. Some implementation dependencies should still be honored inside the sprint plans, especially status/cleanup depending on runtime-state primitives.

## Sprint Mapping

- Sprint 81: BYOMem Status Command
- Sprint 82: BYOMem Cleanup And Stop Command
- Sprint 83: Runtime State And Pidfile Ownership
- Sprint 84: BYOMem Doctor Diagnostics
- Sprint 85: Connect Codex Setup Command
- Sprint 86: Remove And Uninstall Workflow
- Sprint 87: Codex Lifecycle Release Polish
- Sprint 88: Lightweight Runtime Dashboard
- Sprint 89: Session Replay And Import
- Sprint 90: Structured Runtime Health Contracts
- Sprint 91: One-Command Demo And Smoke Test
