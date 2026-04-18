# Sprint 15: TS Doc Cleanup and Legacy Retirement

## Goal / Objective
Retire markdown-first assumptions in BYOMem docs and code paths, and make the TypeScript-native flow the default documented implementation path.

## Scope / Workstreams
- Update doc references to favor the new TS-native sprint sequence.
- Reduce or remove outdated markdown-first implementation language.
- Identify any lingering compatibility shims that should be deprecated or removed.
- Tighten verification coverage around native behavior and optional projections.

## Dependencies
- Sprint 11 through Sprint 14 completion.
- Current roadmap and sprint docs in `docs/`.
- Existing native storage, read, write, and retrieval behavior.

## Acceptance Criteria
- The docs point readers to the TS-native sprint sequence first.
- Legacy markdown-centric assumptions are clearly marked as deprecated or optional.
- Remaining compatibility behavior is intentional and documented.

## Verification Steps
- Review the BYOMem docs for markdown-first wording and update as needed.
- Confirm the sprint sequence links are consistent across roadmap and sprint docs.
- Check that native verification steps are the primary guidance.

## Risks / Notes
- Removing compatibility too early can disrupt callers still relying on old paths.
- Documentation cleanup should not outpace the actual runtime behavior.

## See Also
- [Sprint 11: TS BYOMem Contracts and Parity](./sprint-11-ts-byomem-contracts-and-parity.md)
- [Sprint 12: TS Native Read Path](./sprint-12-ts-native-read-path.md)
- [Sprint 13: TS Native Write Path and Migration](./sprint-13-ts-native-write-path-and-migration.md)
- [Sprint 14: TS Native Retrieval and Ranking](./sprint-14-ts-native-retrieval-and-ranking.md)
