"""Adapters that bridge existing write-path artifacts into memory contracts."""

from __future__ import annotations

from pathlib import Path
import re

from pydantic import ValidationError

from core.models import MemoryRecord, MemoryScope


def _relative_source_prefix(source_kind: str, path: Path, project_name: str | None = None) -> str:
    rel_path = path
    if project_name is not None and project_name in path.parts:
        rel_path = Path(project_name, *path.parts[path.parts.index(project_name) + 1 :])
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
        source=_relative_source_prefix(source_kind, artifact_path, project),
        content=content,
    )


def project_memory_path_to_memory_record(
    *,
    project_root: Path,
    memory_path: Path,
    source_kind: str,
    scope_hint: str | None = None,
) -> MemoryRecord:
    if scope_hint is not None and scope_hint not in {"project", "dir", "user", "agent"}:
        raise ValidationError.from_exception_data(
            "MemoryRecord",
            [
                {
                    "type": "literal_error",
                    "loc": ("scope_hint",),
                    "msg": "Input should be 'project', 'dir', 'user', or 'agent'",
                    "input": scope_hint,
                    "ctx": {"expected": "'project', 'dir', 'user', or 'agent'"},
                }
            ],
        )

    scope: MemoryScope = "dir" if memory_path.parent != project_root else "project"
    return MemoryRecord(
        id=memory_path.stem,
        scope=scope,
        source=_relative_source_prefix(source_kind, memory_path, project_root),
        content=memory_path.read_text(),
    )
