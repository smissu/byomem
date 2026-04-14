"""RED seam-bridging tests for mapping write-path artifacts into memory contracts."""

import pytest
from pydantic import ValidationError

from core.models import MemoryRecord


def test_branch_artifact_to_memory_record_adapter_maps_provenance_and_scope(tmp_path):
    from core.memory_adapter import branch_artifact_to_memory_record

    branch_root = tmp_path / "project-x" / "branches" / "2026-04-14-abc12345"
    branch_root.mkdir(parents=True)
    commit_md = branch_root / "commit.md"
    commit_md.write_text(
        "## This Commit's Contribution\n"
        "**[FEATURE] Added memory seam** <!-- turn: turn-9 -->\n"
        "Mapped branch artifact into contract\n"
    )

    record = branch_artifact_to_memory_record(
        project="project-x",
        artifact_path=commit_md,
        source_kind="branch_commit",
        scope="project",
        turn_id="turn-9",
    )

    assert isinstance(record, MemoryRecord)
    assert record.scope == "project"
    assert record.source == "branch_commit:project-x/branches/2026-04-14-abc12345/commit.md"
    assert "Added memory seam" in record.content


def test_branch_artifact_to_memory_record_rejects_missing_provenance(tmp_path):
    from core.memory_adapter import branch_artifact_to_memory_record

    artifact = tmp_path / "main.md"
    artifact.write_text("content without provenance")

    with pytest.raises(ValidationError):
        branch_artifact_to_memory_record(
            project="project-x",
            artifact_path=artifact,
            source_kind="branch_commit",
            scope="project",
        )


def test_project_memory_path_to_memory_record_adapter_infers_dir_scope_from_subdirectory(tmp_path):
    from core.memory_adapter import project_memory_path_to_memory_record

    project_root = tmp_path / "project-x"
    memory_file = project_root / "subdir" / "MEMORY.md"
    memory_file.parent.mkdir(parents=True)
    memory_file.write_text(
        "## Auto-captured\n"
        "- [2026-04-14] Nested memory note: directory scoped content\n"
    )

    record = project_memory_path_to_memory_record(
        project_root=project_root,
        memory_path=memory_file,
        source_kind="project_memory",
    )

    assert record.scope == "dir"
    assert record.source.endswith("subdir/MEMORY.md")
    assert "directory scoped content" in record.content


def test_project_memory_path_to_memory_record_uses_supported_scope_hint(tmp_path):
    from core.memory_adapter import project_memory_path_to_memory_record

    memory_file = tmp_path / "MEMORY.md"
    memory_file.write_text("content")

    record = project_memory_path_to_memory_record(
        project_root=tmp_path,
        memory_path=memory_file,
        source_kind="project_memory",
        scope_hint="user",
    )

    assert record.scope == "user"


def test_main_md_path_normalizes_to_memory_record(tmp_path):
    from core.memory_adapter import persisted_artifact_to_memory_record

    main_md = tmp_path / "main.md"
    main_md.write_text(
        "# project-x\n\n"
        "## Key Decisions & Fixes\n"
        "- [2026-04-14] [FEATURE] Added memory seam: mapped from main.md\n"
    )

    record = persisted_artifact_to_memory_record(
        project_root=tmp_path,
        artifact_path=main_md,
        source_kind="main_md",
        scope="project",
    )

    assert isinstance(record, MemoryRecord)
    assert record.scope == "project"
    assert record.source.endswith("main.md")
    assert "Added memory seam" in record.content


def test_branch_log_path_normalizes_to_memory_record(tmp_path):
    from core.memory_adapter import persisted_artifact_to_memory_record

    log_md = tmp_path / "branches" / "2026-04-14-abc12345" / "log.md"
    log_md.parent.mkdir(parents=True)
    log_md.write_text(
        "<!-- last_id: turn-1 -->\n"
        "---\n"
        "**[2026-04-14T10:00:00]** user asked for scope-aware retrieval\n\n"
        "assistant recorded the outcome\n"
    )

    record = persisted_artifact_to_memory_record(
        project_root=tmp_path,
        artifact_path=log_md,
        source_kind="branch_log",
        scope="project",
        turn_id="turn-1",
    )

    assert record.scope == "project"
    assert record.source.endswith("branches/2026-04-14-abc12345/log.md")
    assert "scope-aware retrieval" in record.content
