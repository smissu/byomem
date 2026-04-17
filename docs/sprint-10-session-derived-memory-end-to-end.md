# Sprint 10: Session-Derived Memory End-to-End

## Sprint goal
Make session-derived memories work end-to-end in BYOMem using the target DB-first / native-first architecture: capture from Pi sessions, distill into native records, mirror only as needed, and retrieve through the native BYOMem API/DB path.

## Current state / problem statement
Recent findings indicate:

- Pi hooks now fire and the session-capture bridge can succeed.
- Raw transcript capture is confirmed.
- Markdown writing can be disabled.
- Native mirroring exists, but live native durable writes for tested markers are not yet cleanly proven.
- Observability and log-root confusion made verification harder.
- The target architecture is native-first: session knowledge should be stored as durable BYOMem records, not treated as markdown-first artifacts.

The remaining work is to close the gap between successful capture and verified durable native session memory storage/retrieval.

## Workstreams / stories

### 1) Prove durable native writes for session-derived records
- Ensure captured session-derived memory records are written to the native store reliably.
- Verify the native record path used by session capture is the same durable path used by other BYOMem-native writes.
- Confirm records survive reload and appear in native search/index structures.

### 2) Standardize session-derived record shape and provenance
- Define the canonical native record fields for session-derived memories.
- Include project scope, session provenance, and capture metadata.
- Ensure raw transcript references remain available without making markdown the source of truth.

### 3) Remove markdown dependency from the retrieval path
- Keep markdown optional for export/projection only.
- Ensure retrieval uses the native BYOMem API/DB path for session-derived memories.
- Avoid grep-based discovery over markdown as the primary memory lookup mechanism.

### 4) Fix observability and log-root clarity
- Make capture and write logs point to the actual store paths.
- Separate raw transcript capture logs, native write logs, and index/search logs.
- Reduce ambiguity around which root is being written or queried.

### 5) Add end-to-end verification coverage
- Add tests that prove a session capture marker becomes a native durable record.
- Add tests for reload, retrieval, and provenance linkage.
- Add tests that confirm markdown output can be disabled without breaking native storage.

## Acceptance criteria
- A Pi session capture produces a native BYOMem memory record with project scope and session provenance.
- The record is durably written and survives reload.
- The record is retrievable via the native BYOMem API/DB path.
- Markdown output is optional and does not participate in primary retrieval.
- Logging makes it clear which store/root received the record.
- Tests demonstrate the full flow from capture to durable native retrieval.

## Verification steps
1. Trigger a known session-capture marker through the Pi hook/bridge.
2. Confirm raw transcript capture succeeds.
3. Confirm the session-derived memory is written to the native store.
4. Reload the store and verify the record persists.
5. Query the native BYOMem retrieval path and confirm the record is returned.
6. Confirm markdown writing can be disabled without affecting steps 1–5.
7. Review logs to ensure the observed root/path matches the actual write target.

## Risks
- Session capture may appear successful while native durability still fails or writes to the wrong root.
- Log and path confusion may mask partial success.
- Legacy markdown code paths may still influence behavior or verification.
- Search/index updates may lag durable writes if not wired atomically.
- Provenance metadata may be incomplete unless standardized early.

## Recommended order of implementation
1. Fix observability and root/path clarity so writes can be verified unambiguously.
2. Prove durable native writes for session-derived records.
3. Standardize the session-derived record shape and provenance metadata.
4. Wire retrieval to the native API/DB path only.
5. Keep markdown as an optional projection/export layer.
6. Add end-to-end tests covering capture, durability, reload, and retrieval.
