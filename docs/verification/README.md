# Verification Notes

## BYOMem TS-native parity groundwork
This directory holds lightweight verification notes and fixtures for the TypeScript-native BYOMem migration.

### Sprint 11 parity slice
- Treat the current Python-backed BYOMem behavior as the baseline contract.
- Capture normalized request/response shapes for store, search, session-capture checkpoint, and session-capture flush flows.
- Prefer small JSON fixtures that can be replayed later by a TS-native harness.
- Keep fixture names stable and repo-relevant so future parity tests can compare outputs directly.
- Treat markdown as a projection/export artifact, not the authoritative memory store.

### Sprint 12 read-path slice
- Treat durable native storage as the read-path baseline.
- Verify retrieval from native storage survives in-process reset/reload without markdown dependence.
- Keep identity, provenance, scope, and session-capture read coverage aligned with the current unit tests.
- Use the native read path directly; markdown is not required for passing verification.

### Sprint 13 write-path slice
- Treat the native write path as authoritative for new records.
- Preserve write metadata contracts on store, including provenance, scope, identity, source kind, and source ref where present.
- Keep markdown optional and non-authoritative on write.
- Bound migration to adapter/policy behavior instead of a bulk backfill pass.

### Sprint 14 retrieval/ranking slice
- Treat deterministic native retrieval as the contract for ranking and filtering.
- Cover lexical, semantic, and hybrid paths with identity, recency, provenance, and scope awareness where the current tests exercise them.
- Verify reload/reset behavior and markdown-independence for retrieval correctness.
- Keep ranking contract checks tied to native store behavior, not markdown discovery.

### Current intent
These notes are not a full test plan. They exist so Sprint 11 can grow a parity harness incrementally without redesigning the runtime path first.

### Coverage so far
- normalized store replay fixture against current Python-backed behavior
- normalized search replay fixture against current Python-backed behavior
- normalized session-capture checkpoint replay fixture against current Python-backed behavior
- normalized session-capture flush replay fixture against current Python-backed behavior
- retrieval-after-flush proof via replay of the flushed/native-write path
- idempotent replay proof via repeated normalized runs
- live Pi v3 parser regression coverage for top-level `id` / `parentId` event records and list-based content with non-text blocks
- native-read durability proof: retrieval survives in-process reset/reload
- native provenance preservation proof for stored `source_kind` / `source_ref`
- native-write durability proof: records land in native storage and remain retrievable
- metadata contract proof: provenance, scope, identity, source kind, and source ref are preserved on write
- native retrieval/ranking proof: lexical, semantic, and hybrid behavior are exercised by targeted tests
- markdown independence proof for retrieval/ranking behavior

### Useful verification commands
```bash
python -m pytest tests/unit/test_parity_fixtures.py -m parity -q
pytest -q tests/unit/test_parser.py
pytest -q tests/unit/test_memory_retrieval.py::test_retrieval_prefers_stable_identity_within_scope tests/unit/test_memory_retrieval.py::test_retrieval_records_native_provenance_and_avoids_markdown_backing tests/unit/test_memory_retrieval.py::test_retrieval_survives_in_process_reset_and_reloads_persisted_native_store
pytest -q tests/unit/test_pi_adapter.py::test_pi_adapter_project_store_and_ranked_read_round_trip tests/unit/test_pi_adapter.py::test_pi_adapter_exposes_lexical_only_semantic_unavailable tests/unit/test_pi_adapter.py::test_pi_adapter_hybrid_ranking_contract_unchanged tests/unit/test_pi_adapter.py::test_pi_adapter_project_identity_does_not_collide_across_same_leaf_names tests/unit/test_pi_adapter.py::test_pi_adapter_does_not_depend_on_claude_memory_md
```

### Normalized golden outputs
Parity fixtures should compare normalized outputs, not raw filesystem-dependent values. In practice that means store responses should canonicalize paths to the current BYOMem root placeholder before comparison so the same fixture can replay across temp directories and local environments.
