# Sprint Review: Sprint 101 Served Dashboard Refresh And Stale Context Policy
**Date:** 2026-06-04
**Source:** `docs/sprint-101-served-dashboard-refresh-and-stale-context-policy.md`
**Review Method:** Codex orchestration with bounded read-only reviewers
**Completed Reviewers:** Product/MVP reviewer, Safety/read-only reviewer, Codex synthesis
**Timed Out:** TDD/sequencing reviewer

## Summary

Sprint 101 is directionally correct, but the current plan is broader than the minimum needed to fix the stale dropdown/context problem. The must-have implementation should focus on read-only refreshed evidence for the served interactive dashboard, consistent refresh snapshots, manual refresh UI, and fail-closed safety boundaries.

Auto-refresh and lifecycle/confidence display are useful, but they should not block the first implementation unless kept compact. Full stale cleanup policy, cleanup eligibility taxonomy, and broad runtime-state/status/doctor changes should be deferred unless RED tests prove they are required.

## Must Haves

1. **Read-only refresh provider**
   - Add an injectable provider that produces one current dashboard refresh snapshot from read-only evidence.
   - Include `generatedAt`, selected context id, context options, selected dashboard model/JSON evidence, selected HTML, bounded warnings, and bounded errors.
   - Keep collection out of raw HTTP route handlers.

2. **Consistent refresh transaction**
   - Prevent mixing `/api/contexts` from one refresh with `/api/dashboard.json` or `/api/dashboard.html` from another.
   - Use either one aggregate refresh endpoint or a `refreshId/generatedAt` contract that the UI passes through subsequent selected-context requests.

3. **Interactive GET refresh endpoints**
   - Make interactive `/api/contexts`, `/api/dashboard.json?contextId=...`, and `/api/dashboard.html?contextId=...` refresh from the provider instead of startup-cached arrays.
   - Keep non-interactive `dashboard --serve` static with no `/api/*` surface.

4. **Manual refresh UI**
   - Add explicit manual refresh control in `dashboard --serve --interactive`.
   - Show last refreshed time, refresh source/state, and bounded refresh error text.
   - Keep dropdown, selected-context panel, and embedded snapshot synchronized after refresh.

5. **Fail-closed provider errors**
   - Test provider throws, empty/partial snapshots, unknown context, removed context, and malformed refresh payloads.
   - Do not fall back to default context, arbitrary filesystem routes, or stale static HTML in a way that hides the error.

6. **Hard read-only boundary**
   - GET-only endpoints; POST/PUT/PATCH/DELETE reject before provider invocation.
   - `Cache-Control: no-store`; tested JSON/HTML content types and CSP.
   - No imports/calls for cleanup apply, stop/kill, child process, MCP transports, file-search scan/semantic refresh/hot-index, graph update/import, registry mutation, config writes, or runtime-state mutation.
   - No creation of stores, DBs, graph artifacts, queues, runtime-state dirs, or process records.

7. **Unsafe-field omission**
   - Refreshed JSON and HTML must omit raw `argv`, `cwd`, env values, hostnames, transcript ids, process commands, config paths, and raw runtime-state record paths.

8. **Focused regressions**
   - Keep Sprint 98 serve, Sprint 99 read-only/runtime process, and Sprint 100 switcher/read-only tests green.
   - Add Sprint 101 tests for provider contract, served refresh API, error behavior, and boundary/no-create guards.

## Should Haves

- Compact lifecycle/confidence summary limited to what explains context freshness: active/stale/malformed/missing-identity/unknown counts and warnings.
- Optional auto-refresh controls after manual refresh is correct.
- Concrete auto-refresh min/default/max interval, single-flight suppression, cancellation, and failure display/backoff if auto-refresh remains in scope.
- Separate display-only policy guidance from executable suggested actions if cleanup/apply text is shown.
- Lifecycle mapping tests for heartbeat-expired and pid-missing only if those states are implemented.
- Docs/runbook/checklist/version updates after implementation.

## Defer

- Full stale cleanup policy with eligible/refused/unsafe cleanup categories.
- Rich lifecycle taxonomy as an implementation blocker: `heartbeat-expired`, `pid-missing`, duplicate-role cleanup eligibility, and broad policy guidance.
- Broad changes to `runtime-state.ts`, `status-report.ts`, or `doctor.ts` unless required by RED tests.
- Auto-refresh as a release blocker for the stale dropdown fix.
- `dashboard --watch`, browser storage, WebSockets, authenticated proxy/origin policy, replay UI, graph canvas, mutation endpoints, live MCP probing, scans, graph update, semantic refresh, repair/reconnect, and config writes.

## Recommendations To Apply To Sprint Plan

- Reframe Sprint 101 MVP around provider-backed manual refresh first.
- Move full lifecycle policy and auto-refresh from Success Criteria into Should/Phase 2 unless the user explicitly wants them mandatory.
- Add an explicit refresh transaction rule.
- Add provider failure/error tests to Phase 0.
- Add source/no-create guards for any new provider module.
- Make unsupported methods assert that the provider is not invoked.
