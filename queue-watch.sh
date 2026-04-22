#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

runtime_base_dir="${BYOMEM_RUNTIME_BASE_DIR:-$HOME/.byomem/runtime}"

src="ts/packages/runtime/src/cli.ts"
dist="ts/packages/runtime/dist/cli.js"
if [[ ! -f "$dist" || "$src" -nt "$dist" ]]; then
  if ! npm --prefix ts/packages/runtime run build; then
    echo "warning: runtime build failed; using existing dist if queue-observe is available" >&2
    if ! grep -q "queue-observe" "$dist" 2>/dev/null; then
      echo "error: dist CLI does not support queue-observe; run a successful build first" >&2
      exit 1
    fi
  fi
fi

npm run byomem:cli -- queue-observe --base-dir "$runtime_base_dir" --watch "$@"
