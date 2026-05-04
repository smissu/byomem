# byomem — TS-native runtime canonical

This repository now treats the TypeScript runtime/observer path as canonical.

- Active runtime/observer code: `ts/**`, `queue-watch.sh`, `queue-observe`
- Legacy Python implementation has been moved to sibling repo: `/Users/ericsmith/Documents/byomem-python`
- Keep Python surfaces out of this repo unless they are explicit compatibility docs or references.

## Hermes / BYOMem / graphify workflow

Future Hermes sessions in this repo should:
- check project memory first for repo-local decisions and prior durable facts
- use `byomem_file_search` for exact passages, indexed evidence, and semantic matches
- read `graphify-out/GRAPH_REPORT.md` before architecture or cross-module questions
- use graphify queries/paths for relationships that span files
- run `graphify update .` after modifying code files

Historical compatibility docs may remain here, but implementation work should target the TS-native runtime.
