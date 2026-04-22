# byomem — TS-native runtime canonical

This repository now treats the TypeScript runtime/observer path as canonical.

- Active runtime/observer code: `ts/**`, `queue-watch.sh`, `queue-observe`
- Legacy Python implementation has been moved to sibling repo: `/Users/ericsmith/Documents/byomem-python`
- Keep Python surfaces out of this repo unless they are explicit compatibility docs or references.

Historical compatibility docs may remain here, but implementation work should target the TS-native runtime.
