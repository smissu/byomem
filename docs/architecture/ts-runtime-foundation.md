# Sprint 16: TS Runtime Foundation

## Purpose
Sprint 16 starts the actual TypeScript runtime foundation for BYOMem. It establishes the core runtime contracts and boundaries that future TS-native sprints will implement against.

This sprint is the first runtime-foundation step, not the cutover. Python remains the default runtime for BYOMem in the repo today and continues to be the active behavior path until later migration sprints replace it.

## What Sprint 16 establishes
- Canonical TS-friendly contracts for memory records, provenance, scope, identity, retrieval results, write intents, and queue/session events.
- Clear runtime boundaries between runtime, store, search, write, session capture, and adapter layers.
- Shared fixtures and contract tests that pin native shapes without requiring a full native implementation.
- The migration sequence for the TS-native path, with later sprints consuming these contracts.

## Runtime boundary model
The intended TS-native layering is:

1. **Runtime**
   - Owns process orchestration, event flow, and runtime wiring.
   - Depends on lower layers only through explicit contracts.

2. **Store**
   - Owns durable record persistence and identity stability.
   - Receives canonical write intents and emits normalized record shapes.

3. **Search**
   - Owns retrieval over stored records and ranking outputs.
   - Consumes stable record and scope contracts only.

4. **Write**
   - Owns validation and normalization of incoming write intents.
   - Produces store-ready records, not runtime side effects.

5. **Session capture**
   - Owns queue/event envelopes for captured or replayed session activity.
   - Emits immutable events into the runtime boundary.

6. **Adapter**
   - Bridges legacy or external integration points into the TS-native runtime.
   - Must not redefine the canonical data model.

## Core contract sketch
### Native memory record
- `id`: stable canonical identifier
- `scope`: `project | user | session | team`
- `provenance`: source, timestamp, adapter metadata
- `content`: text plus optional structured payload
- `identity`: namespace/leaf/context information that keeps the record stable over time

### Write intent
- `intentId`
- `recordId?`
- `scope`
- `source`
- `content`
- `tags?`
- `createdAt`
- `metadata?`

### Queue event
- `eventId`
- `sessionId`
- `recordId`
- `kind`: `capture | flush | write | replay`
- `createdAt`
- `payload`

## Verification posture
Sprint 16 should be verified by contract artifacts, not by runtime cutover.

Minimum documentation and verification expectations:
- fixture-backed examples for the native record and event envelopes
- contract tests that lock identity, provenance, and scope fields
- doc references that keep Python explicitly as the current default runtime

## Migration sequence statement
Sprint 16 is the first step in the TS runtime foundation. It prepares the contract surface for later implementation sprints, but it does not remove Python behavior yet.

Sprint 17 onward consumes these contracts to build the native store, read path, retrieval baseline, and adapter/runtime migration. Python remains the default runtime until the later runtime-cutover work is complete.
