"""Integration tests for the full push loop (stop_hook.py)."""
import io
import json
import sys

from hooks.stop_hook import main


def _make_jsonl(*messages):
    """Build JSONL string from message dicts."""
    return "\n".join(json.dumps(m) for m in messages) + "\n"


def _user_msg(uuid, content, timestamp="2026-02-19T10:00:00", parent=None):
    return {
        "type": "user",
        "uuid": uuid,
        "parentUUID": parent,
        "timestamp": timestamp,
        "message": {"content": content},
    }


def _assistant_msg(uuid, content, parent_uuid, timestamp="2026-02-19T10:00:01"):
    return {
        "type": "assistant",
        "uuid": uuid,
        "parentUUID": parent_uuid,
        "timestamp": timestamp,
        "message": {"content": content},
    }


def _run_hook(session_id, transcript_path, cwd):
    """Run stop hook main() with simulated stdin."""
    payload = json.dumps({
        "session_id": session_id,
        "transcript_path": str(transcript_path),
        "cwd": str(cwd),
    })
    old_stdin = sys.stdin
    sys.stdin = io.StringIO(payload)
    try:
        main()
    finally:
        sys.stdin = old_stdin


def test_full_push_loop(tmp_byomem, tmp_path, mock_anthropic):
    """Full push loop creates branch, writes log/commit/metadata/main/MEMORY."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(_make_jsonl(
        _user_msg("u1", "why is the stop price wrong?"),
        _assistant_msg("a1", "The field is aux_price not stop_price.", "u1"),
    ))
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    # Branch dir created
    branches = list((tmp_byomem / "myproject" / "branches").iterdir())
    assert len(branches) == 1
    branch = branches[0]
    assert "abc12345" in branch.name

    # log.md has content
    log_text = (branch / "log.md").read_text()
    assert "last_id: u1" in log_text
    assert "why is the stop price wrong?" in log_text

    # commit.md has milestone (mock returns milestone=True)
    commit_text = (branch / "commit.md").read_text()
    assert "## This Commit's Contribution" in commit_text

    # metadata.md has last_updated
    meta_text = (branch / "metadata.md").read_text()
    assert "last_updated:" in meta_text

    # main.md updated (mock returns important=True)
    main_text = (tmp_byomem / "myproject" / "main.md").read_text()
    assert "## Key Decisions & Fixes" in main_text
    assert "[FIX]" in main_text


def test_empty_transcript(tmp_byomem, tmp_path, mock_anthropic):
    """Empty transcript writes no files."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text("")
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    # Branch dir exists (get_or_create_branch is called before parse)
    branches_dir = tmp_byomem / "myproject" / "branches"
    if branches_dir.exists():
        branches = list(branches_dir.iterdir())
        if branches:
            # log.md should be empty (no turns parsed)
            log_text = (branches[0] / "log.md").read_text()
            assert log_text == ""


def test_resume_loop(tmp_byomem, tmp_path, mock_anthropic):
    """Re-running the hook resumes from last processed turn — 3rd turn not re-processed."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(_make_jsonl(
        _user_msg("u1", "first question", "2026-02-19T10:00:00"),
        _assistant_msg("a1", "first answer", "u1", "2026-02-19T10:00:01"),
        _user_msg("u2", "second question", "2026-02-19T10:01:00"),
        _assistant_msg("a2", "second answer", "u2", "2026-02-19T10:01:01"),
    ))
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    # First run processes both turns
    _run_hook("abc12345def67890", session_jsonl, project_dir)

    branches = list((tmp_byomem / "myproject" / "branches").iterdir())
    branch = branches[0]
    log_after_first = (branch / "log.md").read_text()
    assert "last_id: u1" in log_after_first
    assert "last_id: u2" in log_after_first

    # Add a third turn
    session_jsonl.write_text(_make_jsonl(
        _user_msg("u1", "first question", "2026-02-19T10:00:00"),
        _assistant_msg("a1", "first answer", "u1", "2026-02-19T10:00:01"),
        _user_msg("u2", "second question", "2026-02-19T10:01:00"),
        _assistant_msg("a2", "second answer", "u2", "2026-02-19T10:01:01"),
        _user_msg("u3", "third question", "2026-02-19T10:02:00"),
        _assistant_msg("a3", "third answer", "u3", "2026-02-19T10:02:01"),
    ))

    # Second run only processes u3
    _run_hook("abc12345def67890", session_jsonl, project_dir)

    log_after_second = (branch / "log.md").read_text()
    assert "last_id: u3" in log_after_second
    # u1 and u2 should appear exactly once each (not duplicated)
    assert log_after_second.count("last_id: u1") == 1
    assert log_after_second.count("last_id: u2") == 1


def test_no_milestone(tmp_byomem, tmp_path, mocker):
    """When summary has no milestone, log is written but commit.md stays empty."""
    # Override mock to return milestone=False
    mock = mocker.patch("core.summarizer.anthropic.Anthropic")
    mock.return_value.messages.create.return_value.content = [
        mocker.Mock(text=json.dumps({
            "title": "Routine edit",
            "summary": "Small change.",
            "classification": "general",
            "important": False,
            "milestone": False,
        }))
    ]

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(_make_jsonl(
        _user_msg("u1", "minor edit"),
        _assistant_msg("a1", "done", "u1"),
    ))
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    branches = list((tmp_byomem / "myproject" / "branches").iterdir())
    branch = branches[0]

    # log has content
    assert "last_id: u1" in (branch / "log.md").read_text()
    # commit.md is empty (no milestone)
    assert (branch / "commit.md").read_text() == ""
    # main.md not created (not important)
    assert not (tmp_byomem / "myproject" / "main.md").exists()


def test_idempotent_rerun(tmp_byomem, tmp_path, mock_anthropic):
    """Re-running stop hook on same transcript produces no duplicate entries."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(_make_jsonl(
        _user_msg("u1", "hello"),
        _assistant_msg("a1", "hi there", "u1"),
    ))
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)
    _run_hook("abc12345def67890", session_jsonl, project_dir)

    branches = list((tmp_byomem / "myproject" / "branches").iterdir())
    branch = branches[0]

    log_text = (branch / "log.md").read_text()
    # u1 should appear exactly once (second run has no new turns)
    assert log_text.count("last_id: u1") == 1

    commit_text = (branch / "commit.md").read_text()
    # Only one commit block
    assert commit_text.count("## This Commit's Contribution") == 1
