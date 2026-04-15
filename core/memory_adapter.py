"""Adapters that bridge existing write-path artifacts into memory contracts."""

from __future__ import annotations

from pathlib import Path
import re

from pydantic import ValidationError

from core.models import MemoryRecord, MemoryScope


_PERSISTED_ARTIFACT_SOURCES = {
    "main_md": "project_memory",
    "branch_commit": "branch_commit",
    "branch_log": "branch_log",
}


def _relative_source_prefix(source_kind: str, path: Path, project_root: Path | None = None) -> str:
    rel_path = path
    if project_root is not None:
        parts = path.parts
        if project_root.name in parts:
            rel_path = Path(project_root.name, *parts[parts.index(project_root.name) + 1 :])
    return f"{source_kind}:{rel_path.as_posix()}"


def branch_artifact_to_memory_record(
    *,
    project: str,
    artifact_path: Path,
    source_kind: str,
    scope: MemoryScope,
    turn_id: str | None = None,
) -> MemoryRecord:
    content = artifact_path.read_text()
    if "turn:" not in content:
        raise ValidationError.from_exception_data(
            "MemoryRecord",
            [
                {
                    "type": "value_error",
                    "loc": ("content",),
                    "msg": "Value error, artifact content missing provenance",
                    "input": content,
                    "ctx": {"error": ValueError("artifact content missing provenance")},
                }
            ],
        )

    if turn_id and f"turn: {turn_id}" not in content:
        raise ValidationError.from_exception_data(
            "MemoryRecord",
            [
                {
                    "type": "value_error",
                    "loc": ("turn_id",),
                    "msg": "Value error, turn provenance not found",
                    "input": turn_id,
                    "ctx": {"error": ValueError("turn provenance not found")},
                }
            ],
        )

    return MemoryRecord(
        id=re.sub(r"[^a-zA-Z0-9_.-]+", "_", artifact_path.stem),
        scope=scope,
        scope_id=project,
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T00:00:00Z",
        source=_relative_source_prefix(source_kind, artifact_path, Path(project)),
        content=content,
        source_kind=source_kind,
        source_ref=artifact_path.as_posix(),
    )


def persisted_artifact_to_memory_record(
    *,
    project_root: Path,
    artifact_path: Path,
    source_kind: str,
    scope: MemoryScope,
    turn_id: str | None = None,
) -> MemoryRecord:
    if source_kind == "main_md":
        content = artifact_path.read_text()
        return MemoryRecord(
            id=re.sub(r"[^a-zA-Z0-9_.-]+", "_", artifact_path.stem),
            scope=scope,
            scope_id=project_root.name,
            created_at="2026-04-15T00:00:00Z",
            updated_at="2026-04-15T00:00:00Z",
            source=_relative_source_prefix(_PERSISTED_ARTIFACT_SOURCES[source_kind], artifact_path, project_root),
            content=content,
            source_kind=_PERSISTED_ARTIFACT_SOURCES[source_kind],
            source_ref=artifact_path.as_posix(),
        )

    if source_kind == "branch_log":
        content = artifact_path.read_text()
        if "last_id:" not in content:
            raise ValidationError.from_exception_data(
                "MemoryRecord",
                [
                    {
                        "type": "value_error",
                        "loc": ("content",),
                        "msg": "Value error, artifact content missing provenance",
                        "input": content,
                        "ctx": {"error": ValueError("artifact content missing provenance")},
                    }
                ],
            )
        if turn_id and f"last_id: {turn_id}" not in content:
            raise ValidationError.from_exception_data(
                "MemoryRecord",
                [
                    {
                        "type": "value_error",
                        "loc": ("turn_id",),
                        "msg": "Value error, turn provenance not found",
                        "input": turn_id,
                        "ctx": {"error": ValueError("turn provenance not found")},
                    }
                ],
            )
        return MemoryRecord(
            id=re.sub(r"[^a-zA-Z0-9_.-]+", "_", artifact_path.stem),
            scope=scope,
            scope_id=project_root.name,
            created_at="2026-04-15T00:00:00Z",
            updated_at="2026-04-15T00:00:00Z",
            source=_relative_source_prefix(_PERSISTED_ARTIFACT_SOURCES[source_kind], artifact_path, project_root),
            content=content,
            source_kind=_PERSISTED_ARTIFACT_SOURCES[source_kind],
            source_ref=artifact_path.as_posix(),
        )

    if source_kind not in _PERSISTED_ARTIFACT_SOURCES:
        raise ValueError(f"unsupported persisted artifact source_kind: {source_kind}")

    return branch_artifact_to_memory_record(
        project=project_root.name,
        artifact_path=artifact_path,
        source_kind=_PERSISTED_ARTIFACT_SOURCES[source_kind],
        scope=scope,
        turn_id=turn_id,
    )


def project_memory_path_to_memory_record(
    *,
    project_root: Path,
    memory_path: Path,
    source_kind: str,
    scope_hint: str | None = None,
) -> MemoryRecord:
    if scope_hint is not None:
        scope = scope_hint  # intentionally explicit: caller decides final scope
    else:
        scope = "dir" if memory_path.parent != project_root else "project"
    return MemoryRecord(
        id=memory_path.stem,
        scope=scope,
        scope_id=project_root.name,
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T00:00:00Z",
        source=_relative_source_prefix(source_kind, memory_path, project_root),
        content=memory_path.read_text(),
        source_kind=source_kind,
        source_ref=memory_path.as_posix(),
    )
