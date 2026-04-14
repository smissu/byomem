# Pi Memory First Implementation Tranche

## Objective
Deliver the first vertical slice of Pi/byomem integration: a scope-aware, stateless retrieval path that can be exercised from Pi with foundation-level tests.

## Why this slice is first
This tranche comes first because it establishes the contract everything else depends on: scope model, lifecycle behavior, and retrieval shape. Without it, Pi integration work cannot be validated end to end.

## Scope
### In scope
- Scope-aware memory schema / record shape
- Lifecycle states and default handling
- Stateless retrieval contract and response metadata
- Basic Pi-facing wiring needed to invoke retrieval in tests or a thin integration layer

### Out of scope
- Full `pi-byomem` UX polish
- Curation / retention automation
- Advanced ranking experiments
- Broader agent automation (`byomem-agent`)
- Documentation beyond minimal implementation notes

## Likely files / modules to modify or add
> Adjust these once the exact code paths are confirmed.
- Memory schema / model definitions in the byomem core
- Scope validation and lifecycle helpers
- Retrieval API / service module
- Pi integration adapter or command entrypoint
- Tests for schema, lifecycle, and retrieval contract

## Ordered work items
1. Define or confirm the memory record fields, scope enums, and lifecycle states.
2. Add scope validation and default lifecycle handling.
3. Implement or harden the stateless retrieval request/response contract.
4. Wire a minimal Pi-side caller or adapter to invoke retrieval.
5. Add tests for scope filtering, lifecycle filtering, and response shape.
6. Verify the slice passes with the intended MVP behavior only.

## Tests to add first
### Foundation tests
- Scope-aware schema accepts valid `project`, `dir`, `user`, and `agent` records.
- Invalid or ambiguous scope combinations are rejected.
- Lifecycle defaults resolve to `active` when appropriate.
- Lifecycle transitions or persisted states round-trip cleanly.
- Retrieval accepts explicit scope + query inputs with no server session state.
- Retrieval excludes `deleted` and normally excludes `expired` memories.
- Retrieval returns explainability metadata for matched results.

### Likely test files
- `tests/test_memory_schema.py`
- `tests/test_scope_validation.py`
- `tests/test_lifecycle_states.py`
- `tests/test_retrieval_contract.py`
- `tests/test_pi_integration_adapter.py`

## Acceptance criteria / pass-fail criteria
### Pass
- Scope-aware records validate and persist as expected.
- Lifecycle state behavior matches the sprint 1/2 contract.
- Retrieval is stateless and honors scope/lifecycle filters.
- A minimal Pi-facing path can invoke retrieval using the contract.
- The added tests pass and cover the foundation behaviors.

### Fail
- Scope is inferred inconsistently or not validated.
- Retrieval depends on hidden session state.
- Deleted or expired memories leak into normal retrieval.
- The slice requires later-sprint curation or UX work to function.

## Dependencies
- Sprint 1 memory foundation
- Sprint 2 retrieval policy MVP
- Stable scope and lifecycle contracts from the roadmap/backlog

## Open questions
- Which concrete modules own schema vs retrieval logic today?
- Is the first Pi-facing hook a CLI command, adapter, or service wrapper?
- What is the minimum metadata Pi must receive in the first slice?
- Are any existing tests already covering part of the schema or retrieval contract?
