# Sprint 12: TS Native Read Path

## Goal / Objective
Implement and validate the TypeScript-native read path so BYOMem retrieval uses durable native storage instead of markdown discovery. Sprint 12 is now complete for the intended read-path scope: retrieval survives in-process reset/reload without markdown dependence.

## Scope / Workstreams
- Wire read APIs to the native store/index layer.
- Support lookup by stable identity, provenance, and scope metadata.
- Ensure reload/restart behavior still returns previously written records.
- Keep any markdown representation strictly as an export or cache.

## Dependencies
- Sprint 11 TS-native contracts and parity definitions.
- Native storage/stable identity work from Sprint 5.1.
- Query-aware search/ranking behavior from Sprint 5.2.

## Exit Criteria / Results
- A written memory record can be read back through the TS-native path.
- Retrieval survives in-process reset/reload without relying on markdown files.
- Query-based native read coverage includes stable identity, provenance, and scope behavior as exercised by the current tests.
- Session-capture records remain retrievable through the native path.
- Native-read durability is proven by a passing in-process reset/reload replay.
- Markdown is not required for passing read-path verification.

## Verification Commands
- `pytest -q tests/unit/test_memory_retrieval.py::test_retrieval_prefers_stable_identity_within_scope tests/unit/test_memory_retrieval.py::test_retrieval_records_native_provenance_and_avoids_markdown_backing tests/unit/test_memory_retrieval.py::test_retrieval_survives_in_process_reset_and_reloads_persisted_native_store`
- `pytest -q tests/unit/test_memory_retrieval.py`

## Verification Steps
- Write a known record through the native path.
- Restart/reload the relevant service or store.
- Query by identity and by relevant search terms.
- Confirm the same record is returned from the native path.

## Risks / Notes
- Search/index lag can hide whether the native store is correct.
- Read-path bugs may appear as ranking issues if identity handling is weak.

## See Also
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 5.1: Native Storage Stable Identity](./sprint-5.1-native-storage-stable-identity.md)
- [Sprint 5.2: Query-Aware Native Search Ranking](./sprint-5.2-query-aware-native-search-ranking.md)
