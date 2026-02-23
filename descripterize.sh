#!/usr/bin/env bash
# Run descripterizer for one or more projects
# Usage: ./descripterize.sh <project> [project2 ...]
#        ./descripterize.sh --all
#        ./descripterize.sh --force <project>

PYTHON="$HOME/.byomem/.venv/bin/python"
CLI="$HOME/.byomem/cli.py"
CONFIG="$HOME/.byomem/config.yaml"

FORCE=""
PROJECTS=()

for arg in "$@"; do
    case "$arg" in
        --force) FORCE="--force" ;;
        --all)
            # Extract project names from config.yaml
            PROJECTS=($(grep -A 100 '^projects:' "$CONFIG" | grep '^ \{2\}[a-zA-Z]' | sed 's/://; s/^ *//'))
            ;;
        *) PROJECTS+=("$arg") ;;
    esac
done

if [ ${#PROJECTS[@]} -eq 0 ]; then
    echo "Usage: ./descripterize.sh <project> [project2 ...]"
    echo "       ./descripterize.sh --all"
    echo "       ./descripterize.sh --force <project>"
    echo ""
    echo "Available projects:"
    grep -A 100 '^projects:' "$CONFIG" | grep '^ \{2\}[a-zA-Z]' | sed 's/://; s/^ */  /'
    exit 1
fi

for proj in "${PROJECTS[@]}"; do
    echo "==> Descripterizing $proj $FORCE"
    "$PYTHON" "$CLI" descripterize "$proj" $FORCE 2>&1 &
done

echo ""
echo "Started ${#PROJECTS[@]} job(s) in background. Monitor with: ./monitor-queue.sh"
wait
echo "All done."
