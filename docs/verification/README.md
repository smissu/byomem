# Verification Notes

## BYOMem TS-native parity groundwork
This directory holds lightweight verification notes and fixtures for the TypeScript-native BYOMem migration.

### Sprint 11 parity slice
- Treat the current Python-backed BYOMem behavior as the baseline contract.
- Capture normalized request/response shapes for store, search, and session-capture flows.
- Prefer small JSON fixtures that can be replayed later by a TS-native harness.
- Keep fixture names stable and repo-relevant so future parity tests can compare outputs directly.

### Current intent
These notes are not a full test plan. They exist so Sprint 11 can grow a parity harness incrementally without redesigning the runtime path first.

### Coverage so far
- one normalized write replay fixture
- one normalized read/search replay fixture
- one normalized checkpointed session-capture replay fixture
- one normalized flushed/native-write session-capture replay fixture
- all compare against the current Python-backed baseline using normalized outputs

### Run the full Sprint 11 parity baseline
```bash
python -m pytest tests/unit/test_parity_fixtures.py -m parity -q
```

### Normalized golden outputs
Parity fixtures should compare normalized outputs, not raw filesystem-dependent values. In practice that means store responses should canonicalize paths to the current BYOMem root placeholder before comparison so the same fixture can replay across temp directories and local environments.
