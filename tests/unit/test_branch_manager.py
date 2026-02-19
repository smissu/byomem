"""Tests for core.branch_manager — GCC branch lifecycle."""
from datetime import date

from core.branch_manager import (
    _last_turn_id,
    append_to_log,
    commit_milestone,
    get_or_create_branch,
    update_metadata,
)


def test_get_or_create_branch_creates_dir(tmp_byomem):
    branch = get_or_create_branch("myproject", "abcdef1234567890")
    assert branch.path.is_dir()
    today = date.today().isoformat()
    assert branch.path.name == f"{today}-abcdef12"


def test_creates_commit_log_metadata(tmp_byomem):
    branch = get_or_create_branch("myproject", "abcdef1234567890")
    assert branch.commit_md.exists()
    assert branch.log_md.exists()
    assert branch.meta_md.exists()


def test_idempotent(tmp_byomem):
    branch1 = get_or_create_branch("myproject", "abcdef1234567890")
    branch1.commit_md.write_text("existing content")
    branch2 = get_or_create_branch("myproject", "abcdef1234567890")
    assert branch2.commit_md.read_text() == "existing content"


def test_branch_properties(tmp_byomem):
    branch = get_or_create_branch("myproject", "abcdef1234567890")
    assert branch.commit_md == branch.path / "commit.md"
    assert branch.log_md == branch.path / "log.md"
    assert branch.meta_md == branch.path / "metadata.md"


def test_append_to_log_single(tmp_byomem, sample_turn):
    branch = get_or_create_branch("myproject", "sess00001234")
    append_to_log(branch, sample_turn)
    content = branch.log_md.read_text()
    assert f"<!-- last_id: {sample_turn['id']} -->" in content
    assert sample_turn["timestamp"] in content
    assert sample_turn["user"][:300] in content
    assert sample_turn["assistant"][:600] in content


def test_append_to_log_multiple(tmp_byomem, sample_turn):
    branch = get_or_create_branch("myproject", "sess00001234")
    turn2 = {**sample_turn, "id": "uuid-def-456", "user": "second question"}
    append_to_log(branch, sample_turn)
    append_to_log(branch, turn2)
    content = branch.log_md.read_text()
    assert "uuid-abc-123" in content
    assert "uuid-def-456" in content
    assert "second question" in content


def test_commit_milestone_single(tmp_byomem, sample_summary):
    branch = get_or_create_branch("myproject", "sess00001234")
    commit_milestone(branch, sample_summary)
    content = branch.commit_md.read_text()
    assert "## This Commit's Contribution" in content
    assert "[FIX]" in content
    assert sample_summary["title"] in content


def test_commit_milestone_append(tmp_byomem, sample_summary):
    branch = get_or_create_branch("myproject", "sess00001234")
    commit_milestone(branch, sample_summary)
    summary2 = {**sample_summary, "title": "Add retry logic", "classification": "feature"}
    commit_milestone(branch, summary2)
    content = branch.commit_md.read_text()
    assert content.count("## This Commit's Contribution") == 2
    assert "Fix stop price" in content
    assert "Add retry logic" in content


def test_update_metadata(tmp_byomem, sample_turn):
    branch = get_or_create_branch("myproject", "sess00001234")
    update_metadata(branch, sample_turn)
    content = branch.meta_md.read_text()
    assert f"last_updated: {sample_turn['timestamp']}" in content


def test_last_turn_id_empty(tmp_byomem):
    branch = get_or_create_branch("myproject", "sess00001234")
    assert branch.last_turn_id is None


def test_last_turn_id_with_content(tmp_byomem, sample_turn):
    branch = get_or_create_branch("myproject", "sess00001234")
    append_to_log(branch, sample_turn)
    turn2 = {**sample_turn, "id": "uuid-def-456"}
    append_to_log(branch, turn2)
    result = _last_turn_id(branch.log_md)
    assert result == "uuid-def-456"


def test_slug_uses_first_8_chars(tmp_byomem):
    long_id = "abcdefghijklmnopqrstuvwxyz"
    branch = get_or_create_branch("myproject", long_id)
    assert "abcdefgh" in branch.path.name
    assert "abcdefghi" not in branch.path.name
