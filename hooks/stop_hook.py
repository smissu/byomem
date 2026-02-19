#!/usr/bin/env python3
"""
byomem Stop hook — captures Claude Code sessions into ~/.byomem/ markdown files.
Fires after every Claude Code response via the Stop hook mechanism.

Reads session data from stdin JSON, then forks a background process to handle
the heavy LLM summarization work. The foreground process returns immediately
so Claude Code is not blocked by the hook timeout.
"""
import fcntl
import json
import os
import sys
from pathlib import Path

# Allow imports from the parent directory (byomem root)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _log(event: str, **kwargs):
    """Write structured log line to stderr (only visible pre-fork)."""
    entry = {"event": event, **kwargs}
    sys.stderr.write(json.dumps(entry) + "\n")


def _process(session_id: str, transcript: Path, cwd: str):
    """Heavy processing — runs in forked background process."""
    from core.branch_manager import (
        append_to_log,
        commit_milestone,
        get_or_create_branch,
        update_metadata,
    )
    from core.memory_writer import maybe_update_main, maybe_update_project_memory
    from core.parser import parse_new_turns
    from core.search_index import index_file
    from core.summarizer import summarize_turn

    project = Path(cwd).name if cwd else "unknown"
    branch = get_or_create_branch(project, session_id)

    # File lock to prevent concurrent corruption
    lock_path = branch.path / ".lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock_file.close()
        return

    try:
        new_turns = parse_new_turns(transcript, branch.last_turn_id)
        if not new_turns:
            return

        for turn in new_turns:
            append_to_log(branch, turn)
            summary = summarize_turn(turn)

            if summary.get("milestone"):
                commit_milestone(branch, summary)
                index_file(branch.commit_md, project)

            if summary.get("important"):
                maybe_update_main(project, summary)
                maybe_update_project_memory(cwd, summary)
                from core.config import get_config
                main_path = get_config().byomem / project / "main.md"
                if main_path.exists():
                    index_file(main_path, project)

        update_metadata(branch, new_turns[-1])
    finally:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()


def main():
    # Read stdin before forking (stdin not available in child)
    data = json.loads(sys.stdin.read())
    session_id = data["session_id"]
    transcript = Path(data["transcript_path"])
    cwd = data.get("cwd", "")

    _log("hook_start", session_id=session_id)

    if not transcript.exists():
        _log("hook_complete", reason="transcript_not_found")
        return

    # In tests or when BYOMEM_SYNC=1, run synchronously
    if os.environ.get("BYOMEM_SYNC") or os.environ.get("PYTEST_CURRENT_TEST"):
        _process(session_id, transcript, cwd)
        _log("hook_complete", session_id=session_id)
        return

    # Double-fork to fully detach from CC's process group
    pid = os.fork()
    if pid > 0:
        # Parent returns immediately — CC is unblocked
        _log("hook_forked", child_pid=pid)
        return

    # Child: detach from terminal
    os.setsid()
    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)

    # Grandchild: close inherited file descriptors so CC's pipes close
    # This is what actually unblocks CC — Python sys.* redirects aren't enough
    devnull_fd = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull_fd, 0)  # stdin
    os.dup2(devnull_fd, 1)  # stdout
    os.dup2(devnull_fd, 2)  # stderr
    os.close(devnull_fd)

    try:
        _process(session_id, transcript, cwd)
    except Exception:
        pass  # Best-effort — don't crash orphaned process
    finally:
        os._exit(0)


if __name__ == "__main__":
    main()
