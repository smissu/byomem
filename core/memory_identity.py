"""Stable identity helpers for BYOMem-native Pi memory storage."""

from __future__ import annotations

import getpass
import hashlib
import os
from pathlib import Path


def resolve_project_id(cwd: str) -> str:
    project_root = Path(cwd).resolve()
    payload = str(project_root)
    return f"project_{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"


def resolve_project_name(cwd: str) -> str:
    """Derive a stable project name from cwd.

    Prefer the git root directory name when present, otherwise fall back to the
    leaf directory name. If cwd is empty, return "unknown".
    """
    if not cwd:
        return "unknown"
    path = Path(cwd)
    for parent in [path, *path.parents]:
        if (parent / ".git").exists():
            return parent.name
        if parent == parent.parent:
            break
    return path.name or "unknown"


def resolve_user_id() -> str:
    for value in (
        os.environ.get("BYOMEM_USER_ID"),
        os.environ.get("USER"),
        os.environ.get("USERNAME"),
        getpass.getuser(),
    ):
        if value:
            normalized = value.strip()
            if normalized:
                return f"user_{hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:16]}"
    return "user_local"
