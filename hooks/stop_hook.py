#!/usr/bin/env python3
"""
byomem Stop hook — captures Claude Code sessions into ~/.byomem/ markdown files.
Fires after every Claude Code response via the Stop hook mechanism.

Reads session data from stdin JSON, parses new turns, summarizes via Haiku,
and writes to branch files (log.md, commit.md, metadata.md) and optionally
bubbles important items up to main.md and project MEMORY.md.
"""
import fcntl
import json
import sys
from pathlib import Path

# Allow imports from the parent directory (byomem root)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.branch_manager import (
    append_to_log,
    commit_milestone,
    get_or_create_branch,
    update_metadata,
)
from core.memory_writer import maybe_update_main, maybe_update_project_memory
from core.parser import parse_new_turns
from core.summarizer import summarize_turn


def _log(event: str, **kwargs):
    """Write structured log line to stderr."""
    entry = {"event": event, **kwargs}
    sys.stderr.write(json.dumps(entry) + "\n")


def main():
    data = json.loads(sys.stdin.read())
    session_id = data["session_id"]
    transcript = Path(data["transcript_path"])
    cwd = data.get("cwd", "")

    _log("hook_start", session_id=session_id)

    if not transcript.exists():
        _log("hook_complete", reason="transcript_not_found")
        return

    project = Path(cwd).name if cwd else "unknown"
    branch = get_or_create_branch(project, session_id)

    # File lock on the branch directory to prevent concurrent corruption
    lock_path = branch.path / ".lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        _log("hook_complete", reason="lock_held")
        lock_file.close()
        return

    try:
        new_turns = parse_new_turns(transcript, branch.last_turn_id)
        _log("turns_parsed", count=len(new_turns))

        if not new_turns:
            _log("hook_complete", reason="no_new_turns")
            return

        for turn in new_turns:
            append_to_log(branch, turn)
            summary = summarize_turn(turn)

            if summary.get("milestone"):
                commit_milestone(branch, summary)

            if summary.get("important"):
                maybe_update_main(project, summary)
                maybe_update_project_memory(cwd, summary)

            if summary.get("title") == "Session turn":
                _log("summary_fallback_used", turn_id=turn["id"])

        update_metadata(branch, new_turns[-1])
        _log("hook_complete", turns_processed=len(new_turns))
    finally:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()


if __name__ == "__main__":
    main()
