"""Tests for core/reporting.py — stats and health check functions."""

from core.reporting import check_index_health, compute_global_stats, compute_project_stats


def test_project_stats_with_branches(tmp_byomem):
    """Returns correct branch counts and types."""
    proj = tmp_byomem / "myproject" / "branches"
    proj.mkdir(parents=True)
    b1 = proj / "2026-02-19-abc12345"
    b1.mkdir()
    (b1 / "metadata.md").write_text("status: active\ntype: fix\n")
    (b1 / "commit.md").write_text("content")
    b2 = proj / "2026-02-10-def67890"
    b2.mkdir()
    (b2 / "metadata.md").write_text("status: merged\ntype: feature\n")
    (b2 / "commit.md").write_text("other content")

    stats = compute_project_stats("myproject")
    assert stats["branches_total"] == 2
    assert stats["branches_active"] == 1
    assert stats["branches_merged"] == 1
    assert stats["type_distribution"] == {"fix": 1, "feature": 1}
    assert stats["newest_branch"] is not None
    assert stats["oldest_branch"] is not None
    assert stats["disk_usage_bytes"] > 0


def test_project_stats_empty(tmp_byomem):
    """Empty project returns zero counts."""
    stats = compute_project_stats("nonexistent")
    assert stats["branches_total"] == 0
    assert stats["branches_active"] == 0


def test_project_stats_has_main(tmp_byomem):
    """Reports whether main.md exists."""
    proj = tmp_byomem / "myproject"
    proj.mkdir(parents=True)
    (proj / "main.md").write_text("# myproject\n")

    stats = compute_project_stats("myproject")
    assert stats["has_main"] is True


def test_global_stats(tmp_byomem):
    """Global stats aggregates across projects."""
    for name in ["alpha", "beta"]:
        proj = tmp_byomem / name / "branches"
        proj.mkdir(parents=True)
        b = proj / "2026-02-19-abc12345"
        b.mkdir()
        (b / "metadata.md").write_text("status: active\n")

    gstats = compute_global_stats()
    assert gstats["total_projects"] == 2
    assert gstats["total_branches"] == 2


def test_global_stats_empty(tmp_byomem):
    """Empty byomem returns zero stats."""
    gstats = compute_global_stats()
    assert gstats["total_projects"] == 0
    assert gstats["total_branches"] == 0


def test_health_check_clean(tmp_byomem):
    """Clean state reports healthy."""
    health = check_index_health()
    assert health["status"] == "healthy"
    assert health["orphaned_files"] == 0


def test_health_check_missing_metadata(tmp_byomem):
    """Detects branches without metadata.md."""
    proj = tmp_byomem / "myproject" / "branches" / "2026-02-19-abc12345"
    proj.mkdir(parents=True)
    # No metadata.md created

    health = check_index_health()
    assert len(health["missing_metadata"]) == 1
    assert health["status"] == "issues_found"


def test_health_check_orphaned(tmp_byomem, mock_openai_embed):
    """Detects orphaned search index entries."""
    proj = tmp_byomem / "proj"
    proj.mkdir(parents=True)
    f = proj / "doc.md"
    f.write_text("will be orphaned")
    from core.search_index import index_file

    index_file(f, project="proj")
    # Delete file but leave index
    f.unlink()

    health = check_index_health()
    assert health["orphaned_files"] == 1
    assert health["status"] == "issues_found"
