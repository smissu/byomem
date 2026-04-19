# Sprint 9 — Team Dispatcher BYOMem Memory Adaptation

## Status
- Draft / implementation plan
- Focused on automatic adaptation for team mode without a separate BYOMem team switch

## Objective
Make BYOMem adapt automatically when team mode is active, using explicit runtime signals from the CLI/team layer instead of a separate BYOMem-specific team toggle.

The runtime should infer team-mode memory behavior from the execution context, keep dispatcher memory authority explicit, and preserve conservative defaults when the signals are missing or ambiguous.

## Scope
- Automatically adapt BYOMem behavior when team mode is active
- Use runtime signals from the CLI/team layer as the source of truth for mode detection
- Avoid introducing a separate BYOMem team switch
- Define precedence and fallback behavior for conflicting signals
- Clarify dispatcher vs worker memory behavior in team mode
- Add status output so the active memory mode is visible and explainable
- Document config and CLI implications for the auto-detection path

## Problem Statement
Today BYOMem can be made team-aware, but the integration still needs a simple, predictable way to enter that mode.

Users should not have to enable a second, BYOMem-specific team setting. Instead, the CLI or team runtime should already know when a run is a team execution, and BYOMem should follow that signal.

Without this behavior:
- users may need to manage redundant switches
- team-mode memory can drift out of sync with the actual execution mode
- dispatcher and worker behavior can become inconsistent across layers
- ambiguous startup state can make memory access harder to reason about

## Goals
- Detect team mode automatically from runtime signals
- Make the dispatcher the default memory authority in team mode
- Keep workers execution-focused unless explicitly allowed otherwise
- Preserve the existing conservative memory model for non-team runs
- Provide a clear ambiguity fallback when signals disagree or are incomplete
- Surface the resolved memory mode in status output

## Non-Goals
- Do not add a new persistent BYOMem team namespace in this sprint
- Do not redesign the existing memory schema or retrieval contracts
- Do not make workers the default memory authority
- Do not add background memory curation or autonomous summarization
- Do not broaden this sprint into policy changes unrelated to team-mode detection

## Dependencies
- Sprint 7 byomem manage for lifecycle compatibility
- Sprint 6 byomem recent for read-path compatibility
- Sprint 5.2 query-aware retrieval for existing native retrieval behavior
- The CLI/team layer runtime context and signal plumbing that identifies team execution
- Sprint 8 — BYOMem Team Dispatcher Memory (superseded split note) only as historical context if needed

## Investigation Summary
This sprint builds on the assumption that the CLI/team layer can expose explicit runtime signals such as:
- whether the current run is team mode
- which agent role is the dispatcher
- which agents are workers
- whether the run should inherit team-scoped behavior by default

The BYOMem layer should consume those signals rather than inventing its own separate team toggle.

The main implementation question is how to resolve precedence:
- explicit runtime signals should win over inferred heuristics
- ambiguous or missing signals should fall back to conservative non-team behavior
- dispatcher role should be used to authorize direct memory access in team mode

The likely implementation shape is a small resolution layer that converts runtime context into a resolved BYOMem memory mode and role policy.

## Acceptance Criteria
- Team mode is detected automatically from explicit runtime signals
- No separate BYOMem team switch is required in normal use
- The dispatcher can read and write team-context memory when team mode is active
- Workers do not gain shared memory access by default
- Ambiguous or incomplete signals fall back to a safe, conservative mode
- Status output shows the resolved memory mode and why it was chosen
- Configuration and CLI behavior remain understandable and minimally redundant
- Existing retrieval, recent, and manage behavior continues to work on the same native records

## Runtime Contract
The runtime contract should define a small set of signals that BYOMem can trust:
- execution mode: team or non-team
- current role: dispatcher or worker
- explicit team context: present or absent
- policy override: optional, higher-precedence safety or test override

BYOMem should treat these as the authoritative inputs for mode resolution.

Recommended contract behavior:
- explicit execution mode from the CLI/team layer is primary
- dispatcher role enables team-memory authority when team mode is active
- worker role does not imply memory authority
- missing team context must not silently enable team behavior

## Precedence
Mode resolution should follow a clear precedence order:
1. explicit runtime override, when present and allowed
2. explicit team-mode signal from the CLI/team layer
3. dispatcher role paired with valid team context
4. conservative non-team fallback

If signals conflict, the system should prefer safety over convenience and keep memory access constrained.

## Auto-Detection
Auto-detection should rely on runtime signals already emitted by the CLI/team layer rather than probing user intent indirectly.

Expected detection inputs may include:
- team run flag from the CLI
- dispatcher assignment from the team orchestrator
- worker assignment from the team orchestrator
- scoped project/team context attached to the run

Detection should be deterministic and should not require user confirmation when the signals are clear.

## Dispatcher / Worker Behavior
### Dispatcher
In team mode, the dispatcher should:
- retrieve relevant memory before planning or coordination
- store durable team facts, decisions, and outcomes
- remain the memory authority for shared team state
- update memory after worker results when the outcome matters to the team

### Worker
Workers should:
- execute assigned repo tasks
- consume memory context supplied by the dispatcher when needed
- avoid direct shared/team memory reads or writes by default
- only gain direct memory access when a specific workflow and config gate explicitly allow it

## Ambiguity Fallback
When runtime signals are missing, conflicting, or incomplete, BYOMem should fall back to conservative behavior.

Fallback rules:
- do not assume team mode without an explicit signal
- do not grant worker memory authority based on role alone
- prefer non-team policy behavior when the runtime context is unclear
- surface the ambiguity in status output so the user can resolve it

## Status Output
The runtime should expose a concise status view showing:
- resolved BYOMem mode
- whether team mode was detected
- which signal won precedence
- whether the dispatcher has memory authority
- whether worker memory access is restricted
- whether the system fell back due to ambiguity

The status output should be short enough for routine CLI inspection but clear enough to explain why the current memory policy is active.

## Config / CLI Implications
This sprint should keep configuration minimal and avoid a second team toggle.

Implications may include:
- team mode is entered through the CLI/team layer, not a BYOMem-specific switch
- BYOMem config should consume runtime signals instead of duplicating team selection
- explicit debug or override knobs may exist for testing, but they should remain secondary to runtime signals
- status and diagnostics should make it obvious when team-mode adaptation is active

The CLI surface should remain simple: the user activates team mode once, and BYOMem follows that execution context.

## Workstreams
### W1: Runtime signal contract
- define the team-mode and role signals BYOMem consumes
- specify precedence and override rules
- ensure the contract is explicit and testable

### W2: Mode resolution
- resolve BYOMem behavior from runtime signals
- map team/non-team contexts to dispatcher and worker permissions
- implement conservative fallback for ambiguity

### W3: Dispatcher and worker enforcement
- enable dispatcher memory authority in team mode
- keep worker access restricted by default
- preserve compatibility with existing native memory operations

### W4: Status and diagnostics
- add status output for resolved mode and signal precedence
- surface ambiguity and fallback reasons
- keep the output concise and routine-friendly

### W5: Validation and rollout
- add tests for detection, precedence, fallback, and role behavior
- verify no separate team switch is required
- validate compatibility with existing retrieval, recent, and manage paths

## Implementation Phases
### Phase 1: Contract and precedence modeling
- define runtime signals
- document precedence rules
- normalize resolved mode representation

### Phase 2: Auto-detection wiring
- wire CLI/team layer signals into BYOMem mode resolution
- detect team mode without a second switch
- route dispatcher and worker permissions from the resolved state

### Phase 3: Fallback and status output
- implement ambiguity fallback
- expose resolved mode and precedence in status output
- ensure conservative behavior remains the default when signals are unclear

### Phase 4: Compatibility and validation
- verify dispatcher memory access in team mode
- verify worker restrictions by default
- check compatibility with retrieval, recent, and manage operations

### Phase 5: Rollout and documentation
- document the runtime contract and CLI implications
- note safe defaults and failure modes
- confirm no separate BYOMem team switch is required

## Risks
- Conflicting runtime signals could create confusing mode resolution if precedence is not strict
- Auto-detection could become too implicit if status output is weak
- Workers might gain unintended access if role checks are too broad
- A second configuration path could reappear if CLI and BYOMem settings diverge
- Conservative fallback may feel restrictive until the runtime signals are reliable

## Validation Plan
- unit tests for runtime signal parsing and precedence
- tests for automatic team-mode detection without a BYOMem team switch
- tests for ambiguity fallback to conservative behavior
- tests proving dispatcher memory authority in team mode
- tests proving worker access remains restricted by default
- integration checks for status output and existing memory tool compatibility

## Rollout Notes
- keep the existing conservative default until runtime signals are stable
- enable automatic team adaptation only when the CLI/team layer emits explicit signals
- monitor status output during rollout to confirm the resolved mode matches user expectation
- keep override/debug paths secondary and clearly labeled
- avoid introducing any new user-facing team toggle in BYOMem unless a later follow-up proves it is necessary

## Acceptance / Exit Criteria
- BYOMem adapts to team mode automatically from runtime signals
- users do not need a separate BYOMem team switch
- dispatcher memory behavior is active when team mode is active
- worker memory access remains restricted by default
- ambiguous signals fall back safely
- status output clearly reports the resolved mode and precedence
- retrieval, recent, and manage behavior remain compatible with existing native records

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 7 — byomem Manage](./sprint-7-byomem-manage.md)
- [Sprint 6 — byomem Recent](./sprint-6-byomem-recent.md)
- [Sprint 8 — BYOMem Team Dispatcher Memory](./sprint-8-byomem-team-dispatcher-memory.md) (superseded split note)