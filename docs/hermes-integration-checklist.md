# Hermes Integration Checklist — BYOMem

Date: 2026-04-30

Use this checklist to review how BYOMem should be integrated and used from Hermes sessions, especially through direct tools rather than shell-first workflows.

## 1) Project orientation
- [ ] Confirm the repo is treated as TS-native canonical.
- [ ] Confirm legacy Python surfaces are reference-only unless explicitly needed for compatibility.
- [ ] Confirm the main runtime entrypoints are the TS runtime, queue observer, and direct Pi/Hermes tools.

## 2) Hermes-facing tool surface
- [ ] Verify the direct tool names exposed in `ts/packages/runtime/src/pi-extension.ts`.
- [ ] Confirm these memory tools are present and usable:
  - `byomem_runtime_status`
  - `byomem_search`
  - `byomem_store`
  - `byomem_prune`
- [ ] Confirm these file-search tools are present and usable:
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
- [ ] Inspect at least one sample response per tool and confirm the payload is structured and readable.
- [ ] Treat “usable” as: the tool is visible in a live Hermes session and can execute successfully at least once.
- [ ] Treat “structured and readable” as: the tool returns JSON in `content[0].text` plus a machine-readable `details` object.

## 3) Hermes wiring and access path
- [ ] Confirm Hermes can actually load the BYOMem tool surface in a live session, not just in source.
- [ ] Confirm the active BYOMem extension path is the expected one, typically `~/.pi/agent/extensions/byomem/` when using the global Pi extension path.
- [ ] Confirm the repo’s Hermes integration path is documented or discoverable for the intended runtime/session flow.
- [ ] Confirm the MCP config examples for `byomem-bootstrap`, `byomem-readonly`, and `byomem-mcp-mutations` are current and use `<REPO_ROOT>`.
- [ ] Confirm the CLI remains a fallback/debug path, not the primary workflow.
- [ ] Confirm any skill or profile entrypoint needed for stable Hermes usage is documented or planned.

## 4) Runtime and storage model
- [ ] Confirm the native store and queue runtime are initialized from the TS runtime base directory.
- [ ] Confirm `BYOMEM_RUNTIME_BASE_DIR` only affects runtime storage and does not redefine the target project.
- [ ] Confirm project-scoped file search uses `baseDir` / active project identity, not global runtime storage as the project root.
- [ ] Confirm runtime-local async scan jobs are explicitly documented as non-durable.

## 5) Tool usage rules inside Hermes
- [ ] Use `byomem_runtime_status` before assuming the runtime is healthy.
- [ ] Use `byomem_search` for native memory lookup instead of grep over markdown.
- [ ] Use `byomem_store` for durable project facts, decisions, and workflow notes.
- [ ] Use `byomem_prune` only for explicit cleanup.
- [ ] Use `byomem_file_search` for indexed project file lookup.
- [ ] Use `byomem_file_search_status` before scanning if freshness matters.
- [ ] Use `byomem_file_search_scan` only when an explicit refresh is needed.
- [ ] Use `byomem_file_search_semantic_refresh` only when embeddings need refresh without a full scan.

## 6) Project registration and polling
- [ ] Confirm file-search project registration is explicit.
- [ ] Confirm `byomem_file_search_project_register` requires a `baseDir`.
- [ ] Confirm `byomem_file_search_project_list` can be used to inspect state before enabling automation.
- [ ] Confirm `byomem_file_search_project_unregister` soft-disables rather than deleting project history.
- [ ] Confirm polling is session-owned and only enabled intentionally.
- [ ] Confirm polling can be queried and disabled cleanly with the corresponding tools.
- [ ] Confirm the active-project-only polling rule is understood and documented.
- [ ] Confirm polling is not confused with runtime-local async scan jobs.

## 7) Verification checklist
- [ ] Confirm the repo builds successfully with `npm run build`.
- [ ] Confirm tests run successfully with `npm test`.
- [ ] Confirm the local Hermes/Pi environment is available before trying live-session tool checks.
- [ ] Confirm `queue-watch.sh` points at the TS-native `queue-observe` path.
- [ ] Confirm `queue-watch.sh` respects `BYOMEM_RUNTIME_BASE_DIR`.
- [ ] Confirm `queue-observe --watch` returns a sensible runtime snapshot.
- [ ] Confirm one queue/session-capture lifecycle path is observable end to end.
- [ ] Confirm the docs and implementation agree on the current tool list.
- [ ] Confirm the working tree is clean before and after review.

## 8) Must-verify edge cases
- [ ] Confirm `baseDir` points to the target project root and not the global runtime directory.
- [ ] Confirm omitted `baseDir` resolves to the active project when available.
- [ ] Confirm a missing/ambiguous active project fails deterministically instead of falling back silently.
- [ ] Confirm status-only calls do not implicitly scan or refresh embeddings.
- [ ] Confirm async scan mode returns immediately and does not imply durability.
- [ ] Confirm tool error messages are understandable enough for an agent to recover from them.

## 9) Follow-up ideas
- [ ] Check whether the current docs overstate any tool behavior that is still sprint-planned.
- [ ] Check whether the Hermes tool surface needs a skill/update to teach the recommended workflow.
- [ ] Check whether any status or error payloads need more detail for agent usability.
- [ ] Check whether the file-search tools should expose additional guardrails or clearer defaults.
- [ ] If this checklist passes review, convert the verified workflow into a reusable Hermes skill or a short operating runbook.
