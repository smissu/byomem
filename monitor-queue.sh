#!/usr/bin/env bash
# Monitor byomem queue status with auto-refresh
# Usage: ./monitor-queue.sh [interval_seconds]

INTERVAL="${1:-5}"
PYTHON="$HOME/.byomem/.venv/bin/python"
CLI="$HOME/.byomem/cli.py"

exec watch -n "$INTERVAL" "$PYTHON" "$CLI" queue
