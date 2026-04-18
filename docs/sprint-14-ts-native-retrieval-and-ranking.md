# Sprint 14: TS Native Retrieval and Ranking

## Goal / Objective
Harden the TypeScript-native retrieval path so ranking, filtering, and context selection behave predictably on the durable native store.

## Scope / Workstreams
- Tune retrieval for identity, recency, scope, and provenance-aware ranking.
- Ensure native queries return the right record set for BYOMem use cases.
- Validate behavior for team-dispatcher and non-team memory modes where applicable.
- Remove any remaining dependency on markdown discovery for retrieval correctness.

## Dependencies
- Sprint 12 TS native read path.
- Sprint 13 TS native write path and migration.
- Sprint 6 BYOMem recent and Sprint 7 BYOMem manage patterns, where relevant.

## Acceptance Criteria
- Native retrieval returns stable, expected results across common BYOMem queries.
- Ranking behavior is documented and testable.
- Retrieval does not require markdown to resolve correctness.

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
