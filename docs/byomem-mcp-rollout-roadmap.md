# BYOMem MCP Server Rollout — Findings and Sprint Roadmap

Date: 2026-04-30

## Findings from the initial project review

- BYOMem is now clearly TS-native canonical. The active runtime/observer code lives under `ts/**`, plus `queue-watch.sh` and `queue-observe`.
- The current Hermes-facing BYOMem integration is the direct Pi adapter in `ts/packages/runtime/src/pi-extension.ts`.
- The CLI surface exists in `ts/packages/runtime/src/cli.ts`, but it is a fallback/debug surface, not the preferred Hermes integration path.
- No BYOMem MCP server files currently exist in the repo.
- The Hermes native MCP client is the right integration target for external MCP servers: Hermes can discover stdio or HTTP MCP servers and register their tools as native Hermes tools.
- The safest architecture is still: shared runtime logic only, plus thin separate Pi and MCP adapters. Do not import the Pi extension file directly from the MCP server.

## Sprint-planning skill review

I also reviewed the sprint-planning skills before drafting this roadmap:

- `otp-paper/sprint-planning-phase`
- `software-development/hermes-sprint-planning`
- `mcp/native-mcp`

What they imply for this work:

- This is a Heavy planning task because it spans transport, adapter boundaries, shared runtime modules, and live Hermes verification.
- The plan should start with a TDD-first shape, explicit verification commands, and numbered milestones.
- Planning should stay separate from implementation until the sprint artifact is clear and reviewed.
- For MCP work, the first proof should be transport/discovery, not BYOMem logic.

## Architecture guardrails

Safe to share between Pi and MCP:

- runtime business logic
- DB/query helpers
- serialization helpers
- project-resolution helpers
- search/store/prune/file-search core operations

Unsafe to share directly:

- Pi tool-registration code
- MCP tool-registration code
- adapter-specific lifecycle hooks
- transport wiring
- session/platform-specific initialization

Boundary rule:

- A change in the shared core may affect both Pi and MCP, but a Pi wrapper change should not affect MCP if the adapters stay thin and separate.
- The MCP server should not import `pi-extension.ts` directly.
- Keep adapter-specific code tiny and transport-only.

## Revised sprint roadmap

The first draft with three sprints was reviewed as too coarse. The revised plan below splits the work into four smaller sprints so Hermes can verify each layer earlier.

### Sprint 44 — MCP transport bootstrap + Hermes stdio smoke test

Goal: prove Hermes can load and call a trivial external MCP server before any BYOMem logic lands.

TDD start:
- First failing tests: server launches, exposes 1-2 trivial tools, and a tool call returns the expected JSON shape.
- Test files: a new MCP bootstrap test under `ts/packages/runtime/tests/`.
- RED command: targeted test run for the bootstrap server.
- GREEN command: the same targeted test run after implementation.

Scope:
- Add a minimal stdio MCP server entrypoint.
- Expose one or two trivial tools such as `ping` and `version`.
- Add Hermes config/example docs so the server can be loaded in a live session.
- Keep BYOMem logic out of this sprint entirely.
- Do not change `pi-extension.ts`.

Likely files:
- `ts/packages/runtime/src/mcp/server.ts`
- `ts/packages/runtime/src/mcp/tools.ts`
- `ts/packages/runtime/src/mcp/index.ts`
- `ts/packages/runtime/tests/sprint-44-mcp-bootstrap.test.ts`
- `package.json` and/or `ts/packages/runtime/package.json`
- docs example/config snippets

Verification:
- Hermes discovers the server as an MCP server.
- Hermes can list the MCP tools.
- Hermes can call the trivial tools successfully in a live session.
- `npm run build` passes.
- Existing Pi tool wiring tests remain green.

Exit criterion:
- A non-BYOMem MCP server works in Hermes end-to-end.

### Sprint 45 — Shared-core extraction + read-only BYOMem MCP MVP

Goal: extract the shared BYOMem logic cleanly and expose a minimal read-only MCP surface.

TDD start:
- First failing tests: shared-core contract tests and read-only adapter tests.
- Test files: new shared-core and MCP adapter tests, plus Pi regression tests for unchanged tool wiring.
- RED command: targeted tests for shared-core extraction and read-only MCP contracts.
- GREEN command: the same targeted tests after implementation.

Scope:
- Extract shared runtime logic into core modules that both adapters can call.
- Add the first BYOMem MCP tools, but keep them read-only.
- Limit the initial read-only surface to status/search-style calls only.
- Preserve current Pi behavior exactly.
- Do not add store/prune/mutation tools yet.
- Do not add registry/polling tools yet.

Likely files:
- new shared core modules under `ts/packages/runtime/src/`
- `ts/packages/runtime/src/mcp/*`
- `ts/packages/runtime/tests/*shared-core*`
- `ts/packages/runtime/tests/*mcp*`
- Pi wiring regression tests

Verification:
- Live Hermes can call the BYOMem MCP read-only tools.
- Read-only calls do not trigger writes, scans, refreshes, or registration.
- Pi direct tools continue to behave as before.
- Build and targeted regression tests pass.

Exit criterion / MVP:
- At the end of Sprint 45, the repo has a usable BYOMem MCP MVP for inspection and search, with the Pi adapter still intact.

### Sprint 46 — BYOMem mutation tools via MCP

Goal: add the write-path and operational MCP tools once the read-only MVP is stable.

Supporting doc: [Sprint 46 — BYOMem mutation-capable MCP server](./sprint-46-byomem-mcp-mutations.md)

TDD start:
- First failing tests: mutation-tool contracts and baseDir/project-resolution edge cases.
- Test files: dedicated mutation tests under `ts/packages/runtime/tests/`.
- RED command: targeted mutation-tool tests.
- GREEN command: the same targeted tests after implementation.

Scope:
- Add MCP tools for store and prune.
- Add explicit scan/refresh tools if they are part of the shared BYOMem surface.
- Keep the tool surface small and deterministic.
- Make sure temp-data and edge-case tests protect against accidental writes.
- Keep Pi and MCP adapters separate; only the shared core should be reused.

Likely files:
- shared core modules from Sprint 45
- `ts/packages/runtime/src/mcp/*`
- `ts/packages/runtime/tests/*mutation*`

Verification:
- Mutation tools work in a live Hermes session.
- Store/prune/scan behavior is correct on isolated test data.
- Existing read-only MCP tools still work.
- Pi tool regression tests remain green.

Exit criterion:
- BYOMem MCP now covers the core write-path operations safely.

### Sprint 47 — Registry, polling, hardening, and docs

Goal: finish the operational surfaces and make the rollout durable.

Supporting doc: [Sprint 47 — MCP registry, polling hardening, and docs](./sprint-47-byomem-mcp-registry-polling-hardening.md)

TDD start:
- First failing tests: registry and polling contracts, plus docs/config smoke checks if needed.
- Test files: registry/polling/hardening tests under `ts/packages/runtime/tests/`.
- RED command: targeted registry/polling regression runs.
- GREEN command: the same targeted runs after implementation.

Scope:
- Add registry/project-identity tools if still needed on the MCP side.
- Add polling/status hardening if it belongs in the MCP surface.
- Add docs and examples that explain the final adapter split.
- Add parity tests that protect against future Pi/MCP drift.
- Tighten any edge-case behavior around `baseDir`, active-project resolution, and no-scan status calls.

Verification:
- Full build passes.
- Targeted MCP, Pi, and shared-core regressions pass.
- Live Hermes discovery/call checks pass.
- Docs match the implemented contract.

Exit criterion:
- The MCP rollout is complete, documented, and stable enough for regular Hermes use.

## Why this split

- Sprint 44 gives the fastest possible proof that Hermes can load a custom MCP server at all.
- Sprint 45 gets to the earliest practical MVP: a read-only BYOMem MCP server.
- Sprint 46 keeps writes/mutations separate so the risk stays controlled.
- Sprint 47 finishes the operational surface and hardening without turning the earlier sprints into a single giant change.

## Planner review notes applied

This roadmap was revised after planner review. The main changes were:

- Split the original 3-sprint draft into 4 smaller sprints.
- Kept the first sprint strictly transport-only.
- Kept the read-only BYOMem MVP separate from write-path work.
- Kept registry/polling/hardening as its own follow-on sprint.
- Added explicit TDD-start and verification gates for each sprint.

## Final recommendation

Start with Sprint 44 exactly as written. If that passes live Hermes verification, Sprint 45 is the earliest point where the BYOMem MCP server becomes useful as an MVP for read-only inspection and search.
