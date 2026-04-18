# Sprint 14: TS Native Retrieval and Ranking

## Goal / Objective
Harden the TypeScript-native retrieval path so ranking, filtering, and context selection behave predictably on the durable native store. Sprint 14 is complete for the intended scope: retrieval and ranking follow a deterministic native contract without markdown dependence.

## Scope / Workstreams
- Tune retrieval for identity, recency, scope, provenance, and hybrid lexical/semantic ranking.
- Ensure native queries return the right record set for BYOMem use cases.
- Validate behavior for team-dispatcher and non-team memory modes where applicable.
- Remove any remaining dependency on markdown discovery for retrieval correctness.

## Dependencies
- Sprint 12 TS native read path.
- Sprint 13 TS native write path and migration.
- Sprint 6 BYOMem recent and Sprint 7 BYOMem manage patterns, where relevant.

## Exit Criteria / Results
- Native retrieval returns stable, expected results across common BYOMem queries.
- Ranking behavior is documented and testable, including lexical, semantic, and hybrid behavior.
- Identity, recency, provenance, and scope coverage are exercised by the current tests/docs.
- Retrieval survives reload/reset and does not require markdown to resolve correctness.

## Verification Commands
- `pytest -q tests/unit/test_memory_retrieval.py::test_retrieval_prefers_stable_identity_within_scope tests/unit/test_memory_retrieval.py::test_retrieval_records_native_provenance_and_avoids_markdown_backing tests/unit/test_memory_retrieval.py::test_retrieval_survives_in_process_reset_and_reloads_persisted_native_store`
- `pytest -q tests/unit/test_pi_adapter.py::test_pi_adapter_project_store_and_ranked_read_round_trip tests/unit/test_pi_adapter.py::test_pi_adapter_exposes_lexical_only_semantic_unavailable tests/unit/test_pi_adapter.py::test_pi_adapter_hybrid_ranking_contract_unchanged tests/unit/test_pi_adapter.py::test_pi_adapter_project_identity_does_not_collide_across_same_leaf_names tests/unit/test_pi_adapter.py::test_pi_adapter_does_not_depend_on_claude_memory_md`

## Verification Steps
- Seed multiple records with overlapping terms and different scopes.
- Query by identity, recency, and contextual terms.
- Confirm ranking is deterministic enough for the intended use cases.
- Validate a reload does not change the underlying retrieval semantics.

## Risks / Notes
- Ranking changes can have broad effects on caller expectations.
- Over-optimizing one query pattern may degrade others; keep the contract explicit.

## See Also
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 13: TS Native Write Path and Migration](./sprint-13-ts-native-write-path-and-migration.md)
- [Sprint 5.2: Query-Aware Native Search Ranking](./sprint-5.2-query-aware-native-search-ranking.md)
