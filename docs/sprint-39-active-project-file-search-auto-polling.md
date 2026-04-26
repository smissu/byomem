# Sprint 39: Active-Project File-Search Auto Polling

## Objective
Implement opt-in, active-project-scoped auto polling for the BYOMem file-search scanner. Polling should stay globally/default off, run only while the current process/session is actively working in one project, expose clear poll observability, and self-disable after a configurable number of consecutive no-change polls.

## Scope
- In: explicit active-project polling enable/disable/config surfaces, configurable poll interval, configurable idle shutoff, registry/status observability fields, TDD coverage, docs/runbook updates.
- In: preserve current non-polling behavior for direct search/status/scan and registry tools unless a new polling-specific entrypoint is invoked.
- In: process/session-owned polling only; no detached daemon or cross-session background process.
- Out: global scanning of all registered projects, filesystem watcher/`fs.watch` behavior, cross-project polling loops, memory-driven polling eligibility, semantic embedding refresh changes, and broad scheduler redesign beyond the active-project polling contract.

## Investigation Summary
- Current `FileIndexScheduler` has code-internal configurability through constructor options: `debounceWindowMs` defaults to `250` ms and `backstopWindowMs` defaults to `60_000` ms in `ts/packages/runtime/src/file-index-scheduler.ts`.
- That configurability is not currently exposed as a user-facing Pi tool, CLI flag, registry operation, or config setting for file-search polling.
- Sprint 37 registry rows already include `poll_interval_seconds` and `last_scan_at`, but `poll_interval_seconds` is not actively configurable through CLI/Pi tools and there are no `last_poll_at`, `next_poll_at`, consecutive-no-change, or disabled-reason fields.
- Core `openFileSearchDb()` currently defaults `scanOnOpen` and `schedulerEnabled` to true. `ts/packages/runtime/src/file-search-db.ts` also defines `MAX_ACTIVE_PROJECTS = 3`, `DEBOUNCE_WINDOW_MS = 250`, `BACKSTOP_WINDOW_MS = 60_000`, and `DEFAULT_SCANNER_STALE_AFTER_MS = 5 * 60_000`.
- Sprint 38 direct Pi file-search tools intentionally open file search with `scanOnOpen: false` and `schedulerEnabled: false`, so current direct search/status/scan behavior does not start hidden polling.
- The existing scheduler handles `activation`, `post-activity`, and `backstop` refreshes, but it has no idle shutoff, no persisted polling state, no active-project-working-directory lifecycle, and scheduler-triggered scans do not currently update registry `last_scan_at`.
- Current scanner status shows scan lifecycle and embedding diagnostics, but it does not report last poll, next poll, polling enabled state, idle shutoff counters, or why polling is disabled.
- Relevant runtime files: `ts/packages/runtime/src/file-index-scheduler.ts`, `ts/packages/runtime/src/file-search-db.ts`, `ts/packages/runtime/src/file-search-project-registry.ts`, `ts/packages/runtime/src/pi-extension.ts`, `ts/packages/runtime/src/cli.ts`, `ts/packages/runtime/src/store.ts`, `ts/packages/runtime/src/file-search-query.ts`.
- Relevant tests: new focused Sprint 39 suite `ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts`, plus existing regression/contract suites `ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts`, `ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts`, `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`, `ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts`, `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts`, `ts/packages/runtime/tests/cli.test.ts`, and `ts/packages/runtime/tests/byomem-extension-wiring.test.ts`.
- Relevant docs: `docs/semantic-hybrid-document-search-runbook.md`, `docs/sprint-37-file-search-project-registry-and-registration-skill.md`, `docs/sprint-38-pi-extension-file-search-tools.md`.

## Current Polling Interval Answer
The polling interval is only **internally configurable** today through `FileIndexScheduler` constructor options (`backstopWindowMs`), and the active backstop value is supplied from the hard-coded `BACKSTOP_WINDOW_MS = 60_000` constant in `file-search-db.ts`. The registry column `poll_interval_seconds` already exists and is serialized, but there is no setter, CLI flag, Pi tool parameter, or scheduler logic that reads it. It is **not currently user-configurable** through the Pi direct tools, CLI, registry commands, or runtime status/config. Sprint 39 adds an explicit user-facing configuration contract.

## Acceptance Criteria
- **AC39-1:** Polling is globally/default off. Opening the runtime, using memory tools, using registry tools, or using existing file-search search/status/scan tools does not start polling.
- **AC39-2:** Polling is process/session-owned. Enabling polling does not create a detached daemon, watcher, launch agent, or background process that survives the current Pi extension runtime or explicit CLI watch process.
- **AC39-3:** Polling targets exactly one active project per process/session and never iterates all `enabled` registry rows.
- **AC39-4:** Pi polling enable defaults to the active project when `baseDir` is omitted; if no active project can be resolved, polling remains disabled and records `polling_disabled_reason = 'no-active-project'`.
- **AC39-5:** If an explicit Pi polling `baseDir` differs from the active project, polling is rejected/disabled with `polling_disabled_reason = 'not-active-project'`.
- **AC39-6:** When the active project changes away from the polling target or the session is no longer working in that project directory, polling cleanup clears the timer, clears `next_poll_at`, and records a deterministic disabled reason.
- **AC39-7:** CLI polling enable/disable/config/status uses an explicit `--base-dir` requirement unless a dedicated active-project CLI flag is implemented; it must not fall back to a generated temporary directory.
- **AC39-8:** Poll interval is user-configurable and persisted as `poll_interval_seconds`; invalid or too-small intervals fail fast with clear errors.
- **AC39-9:** Idle shutoff is user-configurable and persisted as `idle_disable_after_polls`; after X consecutive poll-triggered scans with no file changes, polling disables with `polling_disabled_reason = 'idle-no-changes'`.
- **AC39-10:** A successful poll-triggered scan counts as no-change only when the scan reports no changed files, no deleted files, and no chunks written; implementation should encode the final exact scan-summary fields in tests.
- **AC39-11:** Consecutive no-change poll counting increments only for successful poll-triggered scans with no indexed content changes and resets to zero when a poll-triggered scan detects changes.
- **AC39-12:** Failed poll-triggered scans do not count as no-change polls; failures surface through existing scanner/registry error fields without incorrectly idle-disabling polling.
- **AC39-13:** Manual scans, search, status, register, unregister, and list operations do not increment poll counters and do not start polling implicitly.
- **AC39-14:** Registry and scanner/status outputs expose stable snake_case/JSON fields: `polling_enabled`, `poll_interval_seconds`, `last_poll_at`, `next_poll_at`, `consecutive_no_change_polls`, `idle_disable_after_polls`, `polling_disabled_reason`, and `last_scan_at`.
- **AC39-15:** `last_poll_at` is updated at poll attempt start, `last_scan_at` is updated only after a successful completed scan, and `next_poll_at` is populated only while polling remains enabled.
- **AC39-16:** Explicit polling disable clears the active timer, clears `next_poll_at`, and records `polling_disabled_reason = 'manually-disabled'` unless a more specific disable reason applies.
- **AC39-17:** When the owning Pi session/runtime ends, polling cleanup clears the timer, clears `next_poll_at`, and records a deterministic session-end disabled reason if state is persisted.
- **AC39-18:** Existing direct Pi tools (`byomem_file_search`, `byomem_file_search_status`, `byomem_file_search_scan`, registry tools) continue to use scheduler-free/non-polling opens unless a new polling-specific tool is invoked.
- **AC39-19:** Core `openFileSearchDb()` scan/scheduler defaults are explicitly decided and regression-tested; if legacy library defaults remain true, all Pi/store/direct paths must still pass explicit non-polling options by default.
- **AC39-20:** Sprint 30/31/33/37/38, CLI, and extension wiring regressions remain green.
- **AC39-21:** Docs explain default-off polling, active-project scope, process lifetime, idle shutoff, configuration, fields, and operational expectations.

## Proposed Polling Field Contract
Add registry/runtime DTO support for:

```ts
interface FileSearchPollingState {
  pollingEnabled: boolean;
  pollIntervalSeconds?: number;
  lastPollAt?: string;
  nextPollAt?: string;
  consecutiveNoChangePolls: number;
  idleDisableAfterPolls?: number;
  pollingDisabledReason?: FileSearchPollingDisabledReason;
  lastScanAt?: string;
}
```

Suggested persisted snake_case columns on `file_search_projects`:

```text
polling_enabled INTEGER NOT NULL DEFAULT 0
poll_interval_seconds INTEGER
last_poll_at TEXT
next_poll_at TEXT
consecutive_no_change_polls INTEGER NOT NULL DEFAULT 0
idle_disable_after_polls INTEGER
polling_disabled_reason TEXT
last_scan_at TEXT -- existing column; normalize update semantics
```

Allowed `polling_disabled_reason` values should be deterministic and documented:

- `default-off`
- `no-active-project`
- `not-active-project`
- `idle-no-changes`
- `manually-disabled`
- `session-ended`
- `project-disabled`
- `unregistered-project`
- `poll-error`

## Proposed User-Facing Surfaces
Final names may be adjusted during implementation, but the sprint should add explicit polling-specific surfaces rather than overloading existing search/status/scan tools.

### CLI
- `file-search-polling-status --base-dir <project> --json`
- `file-search-polling-enable --base-dir <project> --poll-interval-seconds <n> --idle-disable-after-polls <n> --json`
- `file-search-polling-disable --base-dir <project> --json`

CLI enable/disable/config commands must require explicit `--base-dir` unless the implementation introduces a dedicated active-project CLI resolution flag and tests it fail-closed.

### Pi tools
- `byomem_file_search_polling_status`
- `byomem_file_search_polling_enable`
- `byomem_file_search_polling_disable`

Pi polling tools may default to the active project. Existing search/status/scan/registry tools must remain non-polling.

## Execution Mode
standard

Rationale: this work crosses shared persistence schema, scanner/status contracts, timers, CLI, Pi tools, and docs. The safest path is serial: lock RED tests and field semantics first, then add schema/mutators, then active-project poller behavior, then user surfaces and docs.

## Workstreams
- WS-A: persistence/status contract (`file-search-project-registry.ts`, `file-search-db.ts`, status serializers/tests)
- WS-B: active-project poller/runtime behavior (`file-index-scheduler.ts` or new active poller module, `store.ts`, Pi extension lifecycle)
- WS-C: user surfaces (`cli.ts`, `pi-extension.ts`, extension wiring tests)
- WS-D: docs and runbook updates

Because WS-A and WS-B both touch shared runtime contracts, implementation should be mostly standard/serial after RED tests are committed.

## RED Test Strategy
Create a new focused behavioral suite, `ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts`, for the cross-cutting Sprint 39 behavior. Keep older sprint test files for narrower regression and serialization contracts.

Minimum RED cases in the new Sprint 39 suite:
1. Extension/runtime load does not start polling by default and does not create a timer.
2. Default status exposes polling observability fields with `polling_enabled: false`, null timestamps/config where appropriate, zero no-change count, and a deterministic disabled reason.
3. Explicit enable starts polling only for the active project/session; a second project does not inherit polling.
4. Configurable `poll_interval_seconds` is honored by the timer interval and echoed in status.
5. First poll updates `last_poll_at`, `next_poll_at`, and successful `last_scan_at` distinctly.
6. Consecutive successful no-change polls increment `consecutive_no_change_polls`.
7. A poll that detects file changes resets `consecutive_no_change_polls` to zero.
8. Configured idle shutoff disables polling after X consecutive no-change polls, clears `next_poll_at`, records `idle-no-changes`, and prevents later polls.
9. Manual/session disable clears the active timer, clears `next_poll_at`, and records `manually-disabled` or equivalent deterministic reason.
10. Active-project switch or leaving the target project directory cleans up polling, clears `next_poll_at`, records a deterministic reason, and prevents further scans for the old project.
11. Owning session/runtime end cleans up polling and prevents further scans.
12. Existing search/status/scan/registry paths do not start polling or mutate poll counters.

## Phases & Tasks

### Phase 0 — RED Tests / Contract Locking
- [ ] **0.1** Create focused Sprint 39 active-project polling RED suite in `ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts`
  - Role: test-engineer
  - Deliverable: failing behavioral tests for default-off/no-timer load, active-project-only enablement, active-project switch/leaving-dir cleanup, configurable poll interval, poll timestamp updates, no-change counting, reset-on-change, idle shutoff, explicit manual/session disable, owning-session cleanup, no further polls after shutdown, and no implicit polling from existing paths.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts`

- [ ] **0.2** Add registry schema/serialization RED tests in `ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts`
  - Role: test-engineer
  - Deliverable: failing tests for new polling fields, existing-row migration defaults, disabled reason defaults, and stable JSON/snake_case output.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts`

- [ ] **0.3** Add scanner/status observability RED tests in `ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`
  - Role: test-engineer
  - Deliverable: failing tests proving `last_poll_at`, `next_poll_at`, `last_scan_at`, `polling_enabled`, `consecutive_no_change_polls`, `idle_disable_after_polls`, and `polling_disabled_reason` are surfaced and updated according to AC39-8 through AC39-13.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`

- [ ] **0.4** Add CLI polling surface RED tests in `ts/packages/runtime/tests/cli.test.ts`
  - Role: test-engineer
  - Deliverable: failing tests for polling status/enable/disable/config commands, explicit `--base-dir` requirement, invalid interval/threshold rejection, stable JSON output, and no scheduler side effects from existing commands.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/cli.test.ts`

- [ ] **0.5** Add direct Pi polling tool RED tests in `ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts` and `ts/packages/runtime/tests/byomem-extension-wiring.test.ts`
  - Role: test-engineer
  - Deliverable: failing tests for new polling-specific tools, active-project defaulting, mismatch/no-active failure modes, and regression coverage proving existing direct tools remain non-polling.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts`

- [ ] **0.6** Add focused scheduler/refinement regression RED tests in `ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts` and `ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts`
  - Role: test-engineer
  - Deliverable: failing tests for no poll before interval, timer cleanup, failed-poll handling, and no counter mutation from manual status/search/scan.
  - Depends on: none
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts`

### Phase 1 — Persistence and Status Foundation
- [ ] **1.1** Extend registry schema/types/mappers in `ts/packages/runtime/src/file-search-project-registry.ts`
  - Role: typescript-coder
  - Deliverable: additive columns, TypeScript fields, migration-safe defaults, and snake_case serializers for polling state.
  - Depends on: 0.2
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts`

- [ ] **1.2** Add registry polling mutators in `ts/packages/runtime/src/file-search-project-registry.ts`
  - Role: typescript-coder
  - Deliverable: helpers to enable/disable polling, configure interval/idle threshold, record poll attempt/completion, update no-change counters, clear/set disabled reasons, and normalize `lastScanAt` updates.
  - Depends on: 1.1
  - Verify: Sprint 37 and Sprint 33 focused tests pass.

- [ ] **1.3** Thread polling status into scanner status in `ts/packages/runtime/src/file-search-db.ts`
  - Role: typescript-coder
  - Deliverable: `getScannerStatus()` includes polling observability from the registry without triggering scans or timers.
  - Depends on: 1.1, 1.2
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts`

### Phase 2 — Active-Project Polling Runtime
- [ ] **2.1** Introduce a minimal active-project poller boundary
  - Role: typescript-coder
  - Deliverable: either a new `ts/packages/runtime/src/file-search-active-poller.ts` or a narrowly refactored scheduler path that owns one timer for one active project and does not iterate registry rows.
  - Depends on: 0.1, 0.6, 1.2
  - Verify: Sprint 39 and Sprint 30/31 focused tests pass.

- [ ] **2.2** Implement active-project/no-project gating
  - Role: typescript-coder
  - Deliverable: polling starts only when explicitly enabled and active-project identity matches target; no-active, not-active, project-switch, and leaving-directory cases clean up timers and persist deterministic disabled reasons.
  - Depends on: 2.1
  - Verify: active-project/no-project RED tests pass.

- [ ] **2.3** Implement poll tick timing and scan bookkeeping
  - Role: typescript-coder
  - Deliverable: each poll attempt records `last_poll_at`, computes `next_poll_at` while enabled, runs exactly one synchronous scan, updates `last_scan_at` only on success, and avoids semantic embedding refresh.
  - Depends on: 2.2
  - Verify: Sprint 30/33 focused tests pass.

- [ ] **2.4** Implement idle shutoff and explicit/session cleanup
  - Role: typescript-coder
  - Deliverable: no-change poll count increments only on successful unchanged poll scans, resets on changed poll scans, disables polling with `idle-no-changes` at threshold, supports explicit manual disable, and cleans up timers when the owning session/runtime ends.
  - Depends on: 2.3
  - Verify: Sprint 39, Sprint 31, and Sprint 33 focused tests pass.

- [ ] **2.5** Preserve default-off behavior in `ts/packages/runtime/src/store.ts`, `ts/packages/runtime/src/file-search-db.ts`, and direct open paths
  - Role: typescript-coder
  - Deliverable: explicitly decide whether core `openFileSearchDb()` legacy defaults remain `scanOnOpen:true` / `schedulerEnabled:true` or move to default-off; either way, `openNativeStore()` and direct-tool paths remain polling-free unless explicit polling config/action is supplied.
  - Depends on: 2.1-2.4
  - Verify: CLI, Sprint 38 direct-tool regressions, and any added core-default tests pass.

### Phase 3 — CLI and Pi Tool Surfaces
- [ ] **3.1** Add CLI polling commands in `ts/packages/runtime/src/cli.ts`
  - Role: typescript-coder
  - Deliverable: explicit status/enable/disable/config commands with validation, `--base-dir` guardrails, JSON output, and no hidden polling for existing commands.
  - Depends on: 1.2, 2.4
  - Verify: `npm test -- --run ts/packages/runtime/tests/cli.test.ts`

- [ ] **3.2** Add direct Pi polling tools in `ts/packages/runtime/src/pi-extension.ts`
  - Role: typescript-coder
  - Deliverable: `byomem_file_search_polling_status`, `byomem_file_search_polling_enable`, and `byomem_file_search_polling_disable` with strict schemas, active-project defaulting, explicit validation, and safe DTO output.
  - Depends on: 3.1
  - Verify: `npm test -- --run ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts ts/packages/runtime/tests/byomem-extension-wiring.test.ts`

- [ ] **3.3** Preserve existing Pi direct-tool contracts
  - Role: typescript-coder
  - Deliverable: regression tests and code review evidence that `byomem_file_search`, `byomem_file_search_status`, `byomem_file_search_scan`, and registry tools remain scheduler-free/non-polling unless polling-specific tools are invoked.
  - Depends on: 3.2
  - Verify: Sprint 38 tests pass.

### Phase 4 — Docs, Validation, Review
- [ ] **4.1** Update the runbook in `docs/semantic-hybrid-document-search-runbook.md`
  - Role: documenter
  - Deliverable: operator guidance for default-off active-project polling, CLI/Pi commands, interval/idle configuration, field meanings, and troubleshooting.
  - Depends on: 3.1, 3.2
  - Verify: docs review.

- [ ] **4.2** Update registry/tool sprint docs as needed
  - Role: documenter
  - Deliverable: update `docs/sprint-37-file-search-project-registry-and-registration-skill.md` and `docs/sprint-38-pi-extension-file-search-tools.md` to clarify polling eligibility vs active polling execution.
  - Depends on: 4.1
  - Verify: docs review.

- [ ] **4.3** Run targeted Sprint 30-39 regression suite
  - Role: test-engineer
  - Deliverable: evidence that scanner/scheduler/registry/tool behavior remains green.
  - Depends on: implementation tasks
  - Verify:
    ```bash
    npm test -- --run \
      ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts \
      ts/packages/runtime/tests/sprint-30-file-index-scheduler-and-hardening.test.ts \
      ts/packages/runtime/tests/sprint-31-file-search-refinement-and-cleanup.test.ts \
      ts/packages/runtime/tests/sprint-33-file-search-scanner-status.test.ts \
      ts/packages/runtime/tests/sprint-37-file-search-project-registry.test.ts \
      ts/packages/runtime/tests/sprint-38-file-search-extension-tools.test.ts \
      ts/packages/runtime/tests/cli.test.ts \
      ts/packages/runtime/tests/byomem-extension-wiring.test.ts
    ```

- [ ] **4.4** Run full verification
  - Role: builder
  - Deliverable: full automated verification and build evidence.
  - Depends on: 4.3
  - Verify:
    ```bash
    npm test -- --run
    npm run build
    git diff --check
    ```

- [ ] **4.5** Independent review
  - Role: code-reviewer
  - Deliverable: review for timer leaks, hidden polling in direct tools, stale `next_poll_at`, incorrect disabled-reason transitions, schema migration issues, and active-project ambiguity.
  - Depends on: 4.4
  - Verify: review sign-off in implementation notes.

## Risks & Mitigations
- Risk: hidden polling leaks into direct search/status/scan or registry commands. -> Mitigation: dedicated polling-specific tools/commands plus regression tests proving existing tools remain scheduler-free.
- Risk: core `openFileSearchDb()` currently defaults scan/scheduler on, which could surprise new callers. -> Mitigation: make the library default decision explicit in Sprint 39 and require Pi/store/direct paths to pass explicit non-polling options by default.
- Risk: ambiguous active-project resolution accidentally polls an unrelated directory. -> Mitigation: fail closed with `no-active-project` / `not-active-project`, require explicit CLI `--base-dir`, and test same-basename projects.
- Risk: idle shutoff mistakes failed polls or non-index-affecting scans for no-change polls. -> Mitigation: define no-change only as successful completed poll scans with no changed files, no deleted files, and no chunks written; failed polls record errors separately.
- Risk: process/session-owned polling is mistaken for durable daemon behavior. -> Mitigation: document no detached process, no watcher, no cross-session persistence; only registry config/state persists.
- Risk: schema migration breaks existing registry rows. -> Mitigation: additive columns with defaults and tests loading pre-Sprint-39 rows.
- Risk: `last_poll_at`, `next_poll_at`, and `last_scan_at` drift or become stale. -> Mitigation: centralize registry mutators and clear `next_poll_at` whenever polling disables.
- Risk: overfitting to old Sprint 30 multi-project scheduler wording. -> Mitigation: Sprint 39 active poller targets exactly one active project per process/session.

## Implementation Notes
Implemented in Sprint 39:
- Added registry persistence/migration and mutators for polling fields.
- Added `FileSearchActivePoller` for one-project, process/session-owned polling.
- Added Pi tools: `byomem_file_search_polling_status`, `byomem_file_search_polling_enable`, `byomem_file_search_polling_disable`.
- Added CLI commands: `file-search-polling-status`, `file-search-polling-enable`, `file-search-polling-disable`.
- Added focused RED/GREEN coverage in `ts/packages/runtime/tests/sprint-39-file-search-active-project-auto-polling.test.ts` and updated extension wiring tests.
- Verified with targeted Sprint 30/31/33/37/38/39/CLI/extension tests, full `npm test -- --run`, `npm run build`, and `git diff --check`.

Code review follow-up adopted during implementation: poll failures now disable polling with `poll-error`, baseline scan failure clears enabled state, disable reasons are runtime-validated, and Pi disable uses active-project validation.

## Definition of Done
- [x] All acceptance criteria are validated by tests or documented manual smoke evidence.
- [x] Polling remains default/global off unless explicitly enabled through polling-specific surfaces.
- [x] Active-project gating, no-project/not-active rejection, configurable interval, and configurable idle shutoff work.
- [x] Registry/status outputs include all Sprint 39 polling fields with stable semantics.
- [x] CLI and Pi tools expose explicit polling status/enable/disable/config workflows.
- [x] Existing direct file-search tools remain non-polling by default.
- [x] Targeted Sprint 30/31/33/37/38/39/CLI/extension regression suite passes.
- [x] Full `npm test -- --run`, `npm run build`, and `git diff --check` pass.
- [x] Docs/runbook are updated.
- [x] Independent code review signs off.
