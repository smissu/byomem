# AgentMemory-To-BYOMem Dashboard Checklist

This checklist tracks AgentMemory viewer/dashboard capabilities that BYOMem does not yet have. Items are ordered from easiest and lowest-risk to hardest and highest-risk for BYOMem.

Status legend:

- `[ ]` not started
- `[~]` planned or partially covered
- `[x]` implemented in BYOMem

## Current BYOMem Baseline

BYOMem has a static, read-only runtime dashboard over existing `status`, `doctor`, profile, and runtime-state evidence. It can emit JSON, write explicit static HTML, open an explicit HTML file, and serve an explicit HTML snapshot on request. It is still intentionally not a live viewer: no watch mode, client scripts, live refresh, graph update, file scan, cleanup/stop controls, mutation, or replay/import UI.

## Ordering Principles

1. Reuse existing read-only evidence before adding new collectors.
2. Prefer pure model/rendering work before CLI/runtime wiring.
3. Prefer static HTML/JSON snapshot features before anything live, served, opened, or watched.
4. Keep local single-user output ahead of transport, security, and auth work.
5. Keep summary/inspection surfaces ahead of search, graph interaction, delete/import, and governance actions.
6. Put anything involving ports, origins, sessions, background refresh, or mutation near the end.

## Easy Static UX Items

- [x] Add a dashboard footer with runtime version, docs link, repository link, and issue/report link.
- [x] Add clearer generated-at, project base, runtime base, and runtime identity header.
- [x] Add first-run or empty-state guidance when memory, file-search, graph, or runtime-state artifacts are missing.
- [x] Add static capability banners from local runtime/build feature metadata.
- [x] Add richer KPI cards from existing `status` and `doctor` reports.
- [x] Add static memory, file-search, graph, runtime-state, and Codex config summary panels.
- [x] Add collapsible warnings, doctor checks, and suggested actions sections.
- [x] Add copy-friendly suggested-action command cards without executable buttons.
- [x] Add section anchors and simple in-page navigation for static HTML.
- [x] Add static dark/light theme support with dark as the default. Prefer CSS-only rendering first; if a client-side toggle is added later, it must remain no-network and non-mutating.

## Easy CLI Convenience Items

- [x] Add `dashboard --open` for an explicitly generated static HTML file.
- [x] Add `dashboard --serve` for temporary local serving of an explicitly generated static HTML file.
- [x] Add clear JSON write/open/serve reports so automation can detect generated path and URL.
- [x] Add safe port selection or explicit `--port` validation for serve mode.
- [x] Add tests proving `--open` and `--serve` do not open runtime stores, scan files, update graphs, or mutate runtime data.

Note: `--open` and `--serve` are intentionally not part of the first easy sprint. Sprint 88 deliberately rejects both. `--open` is safer than `--serve` if it only opens an explicit `--output` file, but it still introduces platform/browser-launch behavior. `--serve` introduces lifecycle, port, host/origin, CSP, auth, and refresh expectations, so it should follow a stable static dashboard contract.

## Low-Medium Read-Only Data Items

- [x] Add project profile summary: indexed file count, chunk count, language counts, graph node count, graph edge count, and embedding readiness.
- [x] Add static graph summary: node count, edge count, communities, relation counts, last update source, and last import timestamp.
- [x] Add static file-search health summary: scanner state, indexed chunks, embedding provider, missing chunks, failed chunks, and hot-index state.
- [x] Add worker/process panel from runtime-state pidfiles.
- [x] Add runtime process liveness confidence to the dashboard surface.
- [x] Add active session/project switcher from safe runtime-state identity.
- [ ] Add function/tool capability inventory from `byomem_runtime_info`.
- [ ] Add static diagnostics history if BYOMem starts storing prior `status` or `doctor` snapshots.
- [~] Add active MCP runtime-info evidence as a separate non-mutating verification source.
- [ ] Add static audit-style panel for recent explicit CLI operations if an audit log exists.
- [ ] Add bounded client-side filtering/search if BYOMem allows a controlled script-bearing dashboard variant.

## Medium Live Viewer Foundation

- [ ] Add `dashboard --watch` static regeneration mode.
- [~] Add local HTTP dashboard server endpoint for `status`, `doctor`, and dashboard JSON. Dashboard JSON is available in explicit interactive serve mode; status and doctor endpoints remain future work.
- [x] Add opt-in served dashboard dropdown for active BYOMem sessions/projects.
- [ ] Add auto-refresh polling to the served dashboard.
- [ ] Add live connection status indicator.
- [ ] Add tabbed UI shell for Dashboard, Memory, File Search, Graph, Runtime, Diagnostics, and Sessions.
- [ ] Add memory browser tab.
- [ ] Add file-search/project-index browser tab.
- [ ] Add graph status/details tab.
- [ ] Add runtime process/session tab.
- [ ] Add diagnostic/audit tab.

## Medium-Hard Interactive Graph And Activity

- [ ] Add interactive graph canvas.
- [ ] Add graph pan, zoom, and recenter controls.
- [ ] Add graph node hover tooltips.
- [ ] Add graph selected-node detail panel.
- [ ] Add graph search.
- [ ] Add graph type and relation filters.
- [ ] Add graph neighbor expansion.
- [ ] Add graph rebuild/refresh action only after a dry-run/apply safety model exists.
- [ ] Add historical health snapshots.
- [ ] Add activity feed from BYOMem operations.
- [ ] Add project activity heatmap.
- [ ] Add read-only session timeline view from captured Codex sessions.
- [ ] Add importable/replayable session list.

## Hard Replay, Live Updates, And Governance

- [ ] Add WebSocket live updates.
- [ ] Add polling fallback when WebSocket fails.
- [ ] Add replay playback UI.
- [ ] Add session playback controls: play, pause, step, reset, speed.
- [ ] Add replay keyboard shortcuts.
- [ ] Add JSONL replay import UI.
- [ ] Add secure viewer server with nonce-based CSP.
- [ ] Add host allowlist and origin allowlist.
- [ ] Add authenticated REST proxy.
- [ ] Add confirmed governance actions such as memory prune/delete from the viewer.
- [ ] Add mutation-capable graph scan, graph update, file-search scan, cleanup, stop, repair, and reconnect actions with dry-run/apply separation.
- [ ] Add Windows support for `dashboard --open` after macOS/Linux behavior is stable and covered by mocked platform tests.

## Recommended First Tranche

The best first tranche is static dashboard UX polish:

1. Footer and identity metadata.
2. First-run guidance.
3. Runtime capability banners.
4. Richer KPI cards.
5. Static memory/file-search/graph summary panels.
6. Collapsible warnings and doctor checks.
7. Copy-friendly suggested-action cards.
8. Dark-default light/dark theme styling.
9. In-page navigation.

These items improve the dashboard immediately while preserving the Sprint 88 read-only boundary.
