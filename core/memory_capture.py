"""Reviewed post-task capture candidate generation for BYOMem."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from core.memory_identity import resolve_project_id, resolve_user_id
from core.models import MemoryRecord

CaptureScope = Literal["project", "user"]
CaptureDecision = Literal["project", "user", "reject"]


@dataclass(frozen=True)
class MemoryCaptureCandidate:
    scope: CaptureScope
    scope_id: str
    text: str
    summary: str
    source_kind: str = "pi_native_store"
    approved: bool = False


@dataclass(frozen=True)
class CaptureClassification:
    decision: CaptureDecision
    reason: str


def classify_capture_candidate(outcome: str, cwd: str, user_hint: str | None = None) -> CaptureClassification:
    text = outcome.strip().lower()
    if not text:
        return CaptureClassification(decision="reject", reason="empty outcome")
    if any(token in text for token in ["preference", "prefer", "always", "habit"]):
        return CaptureClassification(decision="user", reason="stable user preference")
    if any(token in text for token in ["decision", "fixed", "bug", "root cause", "blocked", "implemented", "shipped"]):
        return CaptureClassification(decision="project", reason="task outcome is project-specific")
    if user_hint and user_hint.strip().lower() in {"user", "personal"}:
        return CaptureClassification(decision="user", reason="explicit user hint")
    return CaptureClassification(decision="project", reason="default to project for ambiguous task outcome")


def generate_capture_candidate(outcome: str, cwd: str, user_hint: str | None = None) -> MemoryCaptureCandidate | None:
    classification = classify_capture_candidate(outcome, cwd, user_hint=user_hint)
    if classification.decision == "reject":
        return None
    scope: CaptureScope = classification.decision
    scope_id = resolve_project_id(cwd) if scope == "project" else resolve_user_id()
    text = outcome.strip()
    summary = text[:120].strip()
    return MemoryCaptureCandidate(scope=scope, scope_id=scope_id, text=text, summary=summary)


def candidate_to_memory_record(candidate: MemoryCaptureCandidate, *, record_id: str, now_iso: str, source: str = "pi:capture") -> MemoryRecord:
    return MemoryRecord(
        id=record_id,
        scope=candidate.scope,
        scope_id=candidate.scope_id,
        created_at=now_iso,
        updated_at=now_iso,
        source=source,
        content=candidate.text,
        source_kind=candidate.source_kind,
    )
