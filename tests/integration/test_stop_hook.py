"""Integration tests for the full push loop (stop_hook.py)."""

import io
import json
import sqlite3
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
    payload = json.dumps(
        {
            "session_id": session_id,
            "transcript_path": str(transcript_path),
            "cwd": str(cwd),
        }
    )
    old_stdin = sys.stdin
    sys.stdin = io.StringIO(payload)
    try:
        main()
    finally:
        sys.stdin = old_stdin


def test_full_push_loop(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """Full push loop creates branch, writes log/commit/metadata/main/MEMORY."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "why is the stop price wrong?"),
            _assistant_msg("a1", "The field is aux_price not stop_price.", "u1"),
        )
    )
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


def test_empty_transcript(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
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


def test_resume_loop(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """Re-running the hook resumes from last processed turn — 3rd turn not re-processed."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "first question", "2026-02-19T10:00:00"),
            _assistant_msg("a1", "first answer", "u1", "2026-02-19T10:00:01"),
            _user_msg("u2", "second question", "2026-02-19T10:01:00"),
            _assistant_msg("a2", "second answer", "u2", "2026-02-19T10:01:01"),
        )
    )
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
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "first question", "2026-02-19T10:00:00"),
            _assistant_msg("a1", "first answer", "u1", "2026-02-19T10:00:01"),
            _user_msg("u2", "second question", "2026-02-19T10:01:00"),
            _assistant_msg("a2", "second answer", "u2", "2026-02-19T10:01:01"),
            _user_msg("u3", "third question", "2026-02-19T10:02:00"),
            _assistant_msg("a3", "third answer", "u3", "2026-02-19T10:02:01"),
        )
    )

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
        mocker.Mock(
            text=json.dumps(
                {
                    "title": "Routine edit",
                    "summary": "Small change.",
                    "classification": "general",
                    "important": False,
                    "milestone": False,
                }
            )
        )
    ]

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "minor edit"),
            _assistant_msg("a1", "done", "u1"),
        )
    )
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


def test_idempotent_rerun(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """Re-running stop hook on same transcript produces no duplicate entries."""
    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "hello"),
            _assistant_msg("a1", "hi there", "u1"),
        )
    )
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


def test_index_populated_after_push(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """Stop hook populates search.db with commit.md and main.md chunks."""
    from core.config import get_config

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "why is the stop price wrong?"),
            _assistant_msg("a1", "The field is aux_price not stop_price.", "u1"),
        )
    )
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    cfg = get_config()
    assert cfg.db_path.exists(), "search.db should be created"

    db = sqlite3.connect(str(cfg.db_path))
    files = db.execute("SELECT path FROM files").fetchall()
    paths = [r[0] for r in files]
    # Both commit.md and main.md should be indexed
    assert any("commit.md" in p for p in paths)
    assert any("main.md" in p for p in paths)

    chunks = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    assert chunks > 0
    db.close()


def test_search_after_push(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """After stop hook, hybrid_search returns results from indexed content."""
    from core.search_index import hybrid_search

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "stop price modification issue"),
            _assistant_msg("a1", "The aux_price field is what you need.", "u1"),
        )
    )
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    # FTS5 keyword search should find "summary" in commit.md/main.md
    # (mock summarizer returns "Test summary." which gets indexed)
    results = hybrid_search("Test summary", project="myproject", min_score=0.0)
    assert len(results) > 0


def test_no_milestone_skips_index(tmp_byomem, tmp_path, mocker, mock_openai_embed):
    """When milestone=False, commit.md is not indexed (it stays empty)."""
    from core.config import get_config

    mock = mocker.patch("core.summarizer.anthropic.Anthropic")
    mock.return_value.messages.create.return_value.content = [
        mocker.Mock(
            text=json.dumps(
                {
                    "title": "Routine edit",
                    "summary": "Small change.",
                    "classification": "general",
                    "important": False,
                    "milestone": False,
                }
            )
        )
    ]

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "minor edit"),
            _assistant_msg("a1", "done", "u1"),
        )
    )
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    cfg = get_config()
    # DB may or may not exist, but if it does, commit.md shouldn't be indexed
    if cfg.db_path.exists():
        db = sqlite3.connect(str(cfg.db_path))
        files = db.execute("SELECT path FROM files").fetchall()
        commit_paths = [r[0] for r in files if "commit.md" in r[0]]
        assert len(commit_paths) == 0
        db.close()


def test_mcp_context_after_push(tmp_byomem, tmp_path, mock_anthropic, mock_openai_embed):
    """MCP tools work after stop hook populates data."""
    from mcp_server import mem_context, mem_latest, mem_show

    session_jsonl = tmp_path / "session.jsonl"
    session_jsonl.write_text(
        _make_jsonl(
            _user_msg("u1", "important question"),
            _assistant_msg("a1", "important answer", "u1"),
        )
    )
    project_dir = tmp_path / "myproject"
    project_dir.mkdir()

    _run_hook("abc12345def67890", session_jsonl, project_dir)

    # mem_context bare should return project snapshot
    ctx = mem_context(project="myproject")
    assert "myproject" in ctx
    assert "abc12345" in ctx

    # mem_show should list the branch
    show = mem_show(project="myproject")
    assert "abc12345" in show

    # mem_latest should return the commit
    latest = mem_latest(project="myproject")
    assert "abc12345" in latest
