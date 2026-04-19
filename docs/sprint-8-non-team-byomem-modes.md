# Sprint 8 — Non-Team BYOMem Modes

## Status
- Draft / implementation plan
- Canonical Sprint 8 plan for non-team BYOMem behavior

## Objective
Define and implement the non-team BYOMem modes `off`, `reviewed`, and `auto-safe` so memory behavior stays explicit, conservative, and predictable when the runtime is not in team mode.

## Scope
- Support non-team BYOMem modes: `off`, `reviewed`, and `auto-safe`
- Keep the behavior tied to the current execution context and project scope
- Add staging and approval mechanics for reviewed writes
- Define trigger points, config, CLI implications, and rollout behavior for non-team mode
- Reuse existing BYOMem-native storage, retrieval, recent, and manage contracts
- Stay focused on non-team execution only

## Problem Statement
Non-team runs need a simple memory policy that is safe by default and easy to explain.

Without a clear non-team mode model:
- memory access may become inconsistent across runs
- writes may happen without explicit approval when they should not
- users may not know whether memory is disabled, staged, or auto-allowed
- runtime behavior can drift away from the intended conservative defaults

## Goals
- Make non-team memory behavior explicit and predictable
- Keep the `off`, `reviewed`, and `auto-safe` modes small and understandable
- Require explicit approval before `byomem_store` in reviewed mode
- Preserve conservative behavior for unsafe or ambiguous cases
- Keep the config and CLI surface minimal
- Reuse the existing native memory record model

## Non-Goals
- Do not cover team-mode dispatcher memory behavior
- Do not introduce a new team namespace or team switch
- Do not redesign storage or retrieval internals
- Do not add background curation or autonomous memory capture
- Do not broaden the scope beyond non-team execution

## Investigation Summary
This sprint builds on the existing BYOMem foundation:
- stable native record identity and project scoping from Sprint 5.1
- query-aware retrieval from Sprint 5.2
- recent retrieval from Sprint 6
- manual lifecycle management from Sprint 7

The remaining gap is a small runtime policy layer for non-team execution:
- `off` should disable memory access unless a higher-level workflow explicitly overrides it
- `reviewed` should stage candidate writes and wait for explicit user approval before persistence
- `auto-safe` should allow only conservative, safe reads/writes

The likely implementation is a thin policy adapter around existing BYOMem operations rather than a new memory system.

## Acceptance Criteria
- Non-team runs support `off`, `reviewed`, and `auto-safe`
- `off` disables memory access by default
- `reviewed` stages writes and requires explicit approval before `byomem_store`
- `auto-safe` allows only conservative memory operations
- Existing retrieval, recent, and manage tools continue to operate on the same native records
- Config and CLI behavior make the active non-team mode visible and understandable
- Tests cover mode resolution, staged approval, and safe fallback behavior

## Execution Mode
Non-team mode should treat memory as a policy-controlled capability attached to the current execution context.

Supported modes:
- `off`: no memory read/write behavior during the run
- `reviewed`: memory can be proposed, but writes remain staged until approved
- `auto-safe`: limited memory read/write operations are allowed automatically when they satisfy conservative safety rules

## Workstreams
### W1: Mode resolution and policy
- define the non-team mode enum and resolution logic
- normalize config values
- enforce conservative fallback behavior

### W2: Reviewed-mode staging
- stage proposed writes in the execution flow
- require explicit user approval before `byomem_store`
- keep staged items out of persistent memory until approved

### W3: Auto-safe behavior
- define conservative read/write rules
- block risky or ambiguous writes
- reuse existing native memory operations where possible

### W4: Runtime integration
- connect non-team policy to tool routing and execution context
- ensure the runtime can distinguish active mode clearly
- preserve compatibility with retrieval, recent, and manage paths

### W5: Validation and rollout readiness
- add tests for mode behavior, staging, approval, and fallback
- verify native-record compatibility
- document safe defaults and rollout assumptions

## Architecture
The architecture should stay layered and minimal:

1. **Execution context** determines the current non-team run state.
2. **Mode policy layer** resolves `off`, `reviewed`, or `auto-safe`.
3. **Staging/approval flow** holds reviewed writes until explicit approval.
4. **Existing BYOMem tools** perform the actual read/write/recent/manage operations when allowed.

This should remain a thin policy wrapper around the current native memory tools, not a separate memory subsystem.

## Trigger Points
- run initialization and context loading
- before any memory read or write tool routing
- when a candidate write is produced in reviewed mode
- before persisting a staged write to `byomem_store`
- when auto-safe safety checks evaluate a candidate operation
- during status/reporting so the active mode is visible

## Staging / Approval Behavior
Reviewed mode should stage candidate writes in the execution flow rather than persisting them immediately.

Expected behavior:
- the staged item is visible to the current run or review flow
- the staged item is not written to persistent BYOMem until approved
- explicit user approval is required before `byomem_store`
- rejection or timeout should leave BYOMem unchanged

The staging mechanism should stay conceptual and lightweight; it is a review gate, not a new permanent memory store.

## Config / CLI Implications for Non-Team Mode
The user should not need a complex config surface to use non-team modes.

Implications may include:
- a single non-team memory mode setting in config or CLI
- conservative defaults when the mode is not explicitly set
- clear status output showing whether memory is off, reviewed, or auto-safe
- no separate team switch in the BYOMem layer
- optional debug overrides only for testing or diagnostics

The CLI should make it obvious which non-team memory behavior is active without introducing extra toggles.

## Implementation Phases
### Phase 1: Policy modeling
- define non-team modes and resolution rules
- normalize configuration values
- establish fallback behavior

### Phase 2: Reviewed-mode staging
- add staging for candidate writes
- require explicit approval before persistence
- keep the staged flow separate from durable memory

### Phase 3: Auto-safe enforcement
- implement conservative safety checks
- allow safe reads/writes only
- block ambiguous or risky operations

### Phase 4: Integration and compatibility
- wire the policy layer into existing tool routing
- verify retrieval, recent, and manage compatibility
- confirm native record handling remains unchanged

### Phase 5: Validation and rollout
- add mode and approval tests
- validate defaults and fallback behavior
- document rollout assumptions and status output

## Risks
- Reviewed-mode staging may confuse users if approval boundaries are unclear
- Auto-safe behavior can become too permissive if safety checks are too broad
- A larger-than-needed config surface could make the mode model harder to reason about
- Non-team and team policy paths could diverge if the boundaries are not kept strict

## Validation
- unit tests for mode parsing and resolution
- tests for `off`, `reviewed`, and `auto-safe`
- tests proving reviewed writes stay staged until approval
- tests proving auto-safe blocks risky operations
- integration checks for retrieval, recent, and manage compatibility
- regression checks to confirm native records remain the same across modes

## Rollout Notes
- ship with conservative defaults
- keep `off` as the safest baseline
- enable `reviewed` before broadening `auto-safe` if needed
- verify the active mode through status output during rollout
- avoid introducing any team-specific behavior in this sprint

## See also
- [Docs index](./README.md)
- [Pi memory roadmap](./pi-memory-roadmap.md)
- [Sprint 7 — byomem Manage](./sprint-7-byomem-manage.md)
- [Sprint 6 — byomem Recent](./sprint-6-byomem-recent.md)
- [Sprint 5.2 — Query-Aware Retrieval on Native Memory Store](./sprint-5.2-query-aware-native-search-ranking.md)