#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$script_dir/queue-watch.sh"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "expected output to contain: $needle" >&2
    exit 1
  fi
}

output="$({ bash "$script" --help 2>&1 || true; } )"
assert_contains "$output" "queue-observe"

if ! grep -q 'BYOMEM_RUNTIME_BASE_DIR' "$script"; then
  echo "expected queue-watch.sh to respect BYOMEM_RUNTIME_BASE_DIR default resolution" >&2
  exit 1
fi

if ! grep -q '\.byomem/runtime' "$script"; then
  echo "expected queue-watch.sh to default to ~/.byomem/runtime" >&2
  exit 1
fi

echo "queue-watch.sh contract checks passed"
