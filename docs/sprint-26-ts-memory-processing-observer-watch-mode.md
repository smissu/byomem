# Sprint 26: TS Memory Processing Observer Watch Mode

## Objective
Add TypeScript-native `--watch` auto-refresh support to the memory-processing observer introduced in Sprint 25 so operators can monitor queue/runtime state continuously from the supported TS command surface. The implementation should remain read-only, preserve the observer’s compact text UX, and avoid reintroducing Python or shell-wrapper dependence for active queue monitoring.

## Background / Prior Context
Sprint 25 establishes the TS-native memory-processing observer as the supported read-only queue/runtime inspection path over `queue.json` and `worker.json`. That sprint intentionally focuses on stable snapshot observation, text/JSON output, and bounded history, while leaving continuous auto-refresh as follow-on work.

Current operator guidance prefers the TS-native `queue-observe --watch` path for active monitoring; any retained `monitor-queue.sh` workflow is legacy/dev-only or non-default.

Historically, auto-refresh came from the legacy shell helper:
- `monitor-queue.sh` wrapped the Python `cli.py queue` command with `watch`
- The UX was terminal polling rather than an integrated TS observer mode

The TS runtime now exposes queue and worker state through snapshot artifacts and observer-friendly interfaces:
- `ts/packages/runtime/src/queue.ts`
- `ts/packages/runtime/src/worker.ts`
- Sprint 25 observer modules and command wiring

This sprint replaces the shell-wrapper dependency for active monitoring with an explicit TS-native `--watch` mode layered on top of the Sprint 25 observer.

## Scope
### In scope
- Add `--watch` auto-refresh support to the supported TS memory-processing observer command
- Support a default refresh interval and optional interval override, e.g. `--watch` and `--watch=<seconds>` or equivalent command-host-compatible syntax
- Refresh compact text output in place for terminal use
- Preserve read-only observer behavior while polling queue/worker snapshots repeatedly
- Handle Ctrl-C / termination cleanly without mutating runtime state
- Add targeted tests for watch-mode argument parsing and core refresh-loop behavior as testable
- Document TS-native watch-mode usage as the default active monitoring workflow

### Out of scope
- New queue mutation features such as pause, purge, retry, or repair
- Streaming/event-driven file watching beyond polling-based refresh
- Dashboard/UI work outside the terminal observer surface
- Reworking the underlying queue or worker persistence format
- Python command or shell-wrapper restoration as the primary supported monitor path
- Advanced multi-pane TUI behavior beyond simple refresh/redraw

## Non-goals
- Replacing all possible uses of external `watch` in one sprint
- Building a full telemetry system or background daemon
- Adding liveness guarantees stronger than the underlying TS worker snapshot model
- Expanding JSON mode into a streaming output protocol in this sprint

## Dependencies
- `docs/sprint-25-ts-memory-processing-observer.md`
- `docs/sprint-24-global-store-project-partitioning-queue-first-single-writer.md`
- `docs/sprint-23-ts-runtime-cutover-legacy-retirement-and-documentation-closure.md`
- `docs/pipeline-architecture.md`
- Sprint 25 observer implementation and command surface
- Current runtime observer data sources:
  - `ts/packages/runtime/src/queue.ts`
  - `ts/packages/runtime/src/worker.ts`

## Investigation Summary
- Sprint 25 should keep `--watch` out of scope to avoid mixing core observer shape work with terminal-refresh behavior
- The old refresh workflow depended on external `watch` plus Python CLI rather than integrated TS command behavior
- The TS observer will already have the core read-only snapshot logic needed for repeated polling
- Watch mode should be layered on top of Sprint 25 observer output rather than embedded into the core state-derivation logic
- The first implementation should prefer terminal polling/redraw over a more complex event-stream or file-watch model

## Acceptance Criteria
- AC-1: The supported TS memory-processing observer command accepts a `--watch` mode that refreshes observer output repeatedly without mutating queue/worker state.
- AC-2: `--watch` with no explicit interval uses a documented default refresh interval.
- AC-3: Users can override the refresh interval with a bounded, validated numeric input.
- AC-4: Watch mode renders readable terminal refresh output for worker state, queue summary, health hints, and recent jobs.
- AC-5: Interrupting watch mode exits cleanly without leaving behind temporary state or requiring Python/shell-wrapper support.
- AC-6: Tests cover argument parsing, invalid interval handling, and the watch-loop integration boundary as appropriate for the command host.
- AC-7: Documentation points active monitoring users to the TS-native `--watch` mode rather than `monitor-queue.sh` as the default path.

## Execution Mode
Standard.

Rationale: watch mode builds directly on the Sprint 25 observer command and is best implemented as one command-surface follow-on rather than parallelized across shared files.

## Phases & Tasks
### Phase 0 — Watch-mode tests and command contract
- [ ] **0.1** Add failing tests for watch-mode flag parsing and interval validation in the relevant TS command test surface
  - Role: test-engineer
  - Deliverable: RED tests for `--watch`, default interval behavior, explicit interval parsing, and invalid interval rejection.
  - Depends on: Sprint 25 observer command wiring
  - Verify: targeted TS command/watch-mode test command for the changed area

- [ ] **0.2** Define the watch-mode command contract and refresh defaults in the observer command module
  - Role: typescript-coder
  - Deliverable: explicit command-surface behavior for watch enablement, interval parsing, redraw strategy, and termination handling.
  - Depends on: 0.1
  - Verify: tests compile against the intended command contract

### Phase 1 — Core watch-loop implementation
- [ ] **1.1** Implement polling-based watch mode in the supported TS observer command path
  - Role: typescript-coder
  - Deliverable: command loop that re-runs observer snapshot rendering at the configured interval.
  - Depends on: 0.1, 0.2
  - Verify: targeted TS command/watch-mode tests pass; manual smoke confirms repeated refresh

- [ ] **1.2** Add terminal redraw/clear behavior suitable for compact repeated observation without changing observer snapshot semantics
  - Role: builder
  - Deliverable: readable in-place refresh output for terminal use.
  - Depends on: 1.1
  - Verify: manual smoke in a terminal shows clean successive refreshes without uncontrolled log spam

### Phase 2 — Hardening and documentation
- [ ] **2.1** Add clean shutdown handling for Ctrl-C and invalid/non-interactive watch usage where applicable
  - Role: builder
  - Deliverable: predictable termination behavior and guardrails for unsupported watch-mode contexts.
  - Depends on: 1.1
  - Verify: manual smoke and targeted tests confirm clean exit behavior

- [ ] **2.2** Update docs to mark TS-native `--watch` as the default active monitoring workflow and clarify the legacy status of `monitor-queue.sh`
  - Role: documenter
  - Deliverable: concise operator guidance for active observer monitoring.
  - Depends on: 2.1
  - Verify: docs review confirms the default monitoring path is the TS-native observer watch mode

## Verification
- Run the targeted TS test command for the watch-mode command surface introduced in this sprint
- Re-run the Sprint 25 observer tests to confirm no regression in non-watch snapshot mode
- Manual smoke:
  - run the TS observer with `--watch` against a temp `--base-dir`
  - confirm periodic refresh at the default interval
  - confirm explicit interval override works
  - confirm invalid interval input fails fast with a clear message
  - confirm Ctrl-C exits cleanly
- Confirm watch mode remains read-only and does not mutate `queue.json` or `worker.json`

## Risks & Open Questions
- Risk: command-host constraints may make interval syntax choice (`--watch 2` vs `--watch=2`) non-uniform.
  - Mitigation: choose the syntax that matches the host’s parser conventions and document it clearly.

- Risk: repeated redraw behavior may differ across terminals or CI/non-interactive environments.
  - Mitigation: keep the redraw strategy simple, detect non-interactive contexts when possible, and validate with manual smoke tests.

- Risk: watch mode could blur the boundary between compact observer output and a fuller TUI feature set.
  - Mitigation: keep this sprint limited to polling-based terminal refresh of the existing observer output.

- Risk: fast polling could create unnecessary filesystem churn or noisy UX.
  - Mitigation: use a conservative default interval and validate interval bounds.

- Open question: whether JSON mode should reject `--watch` explicitly in this sprint or support newline-delimited repeated JSON snapshots later.
- Open question: whether non-interactive environments should fall back to repeated append output or fail fast when `--watch` is requested.

## Definition of Done
- [ ] A TS-native `--watch` mode exists on the supported memory-processing observer command
- [ ] Default and explicit refresh intervals are implemented and validated
- [ ] Watch mode refreshes terminal output cleanly and remains read-only
- [ ] Ctrl-C / termination behavior is clean and predictable
- [ ] Sprint 25 observer behavior remains green and regression-tested
- [ ] Docs describe TS-native watch mode as the default active monitoring path
- [ ] Any retained legacy shell-wrapper monitoring path is clearly documented as non-default or dev-only
