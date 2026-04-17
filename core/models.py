"""Pydantic models for structured data flow throughout byomem.

This file contains the tranche-1 minimum contract only; later sprints may extend
these models, but should avoid breaking the base shape defined here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Turn(BaseModel):
    """A single user-assistant exchange parsed from a JSONL transcript."""

    id: str
    timestamp: str = ""
    user: str = ""
    assistant: str = ""


class TurnSummary(BaseModel):
    """LLM-generated summary of a single turn."""

    title: str = "Session turn"
    summary: str = ""
    classification: Literal["fix", "decision", "feature", "research", "general"] = "general"
    important: bool = False
    milestone: bool = False


class BatchSummaryItem(TurnSummary):
    """TurnSummary with the turn ID it corresponds to."""

    turn_id: str


class BatchSummaryResponse(BaseModel):
    """Response wrapper for batch summarization."""

    summaries: list[BatchSummaryItem]


class QueueJob(BaseModel):
    """A job file written by the stop hook for the worker to process."""

    session_id: str
    transcript_path: str
    cwd: str = ""
    model_override: str | None = None
    created_at: str = ""
    transcript_offset: int = 0
    retry_count: int = 0
    last_error: str = ""


class ChunkDescription(BaseModel):
    """LLM-generated description of a single code chunk."""

    chunk_id: str
    description: str

    @field_validator("chunk_id", mode="before")
    @classmethod
    def _coerce_chunk_id(cls, v):
        return str(v) if not isinstance(v, str) else v


class BatchDescriptionResponse(BaseModel):
    """Response wrapper for batch code chunk descriptions."""

    descriptions: list[ChunkDescription]


MemoryScope = Literal["project", "dir", "user", "agent"]
MemoryLifecycle = Literal["active", "superseded", "archived", "deleted", "expired"]


class MemoryRecord(BaseModel):
    """Canonical memory record for tranche-1 contract tests.

    Retrieval metadata such as score or explainability belongs on the response
    envelope, not on the stored memory record.
    """

    id: str
    scope: MemoryScope
    scope_id: str
    created_at: str
    updated_at: str
    source: str
    content: str
    lifecycle: MemoryLifecycle = "active"
    expires_at: str | None = None
    tags: list[str] = Field(default_factory=list)
    source_kind: str | None = None
    source_ref: str | None = None


class MemoryRetrievalResult(BaseModel):
    """Returned retrieval result with compact explainability metadata."""

    record: MemoryRecord
    reason: str = "scope/lifecycle match"
    provenance: str = ""

    def __getattr__(self, item: str):
        return getattr(self.record, item)


class MemoryRetrievalRequest(BaseModel):
    """Stateless retrieval request contract."""

    query: str
    scope: MemoryScope
    filters: dict[str, str | list[str]] = Field(default_factory=dict)

    @field_validator("filters")
    @classmethod
    def _validate_filters(cls, value: dict[str, str | list[str]]):
        allowed_keys = {"project", "dir", "user", "agent", "lifecycle", "source", "cwd"}
        if not value:
            raise ValueError("filters must include at least one supported filter")
        invalid_keys = set(value) - allowed_keys
        if invalid_keys:
            raise ValueError(f"unsupported filters: {', '.join(sorted(invalid_keys))}")
        return value


class MemoryRetrievalResponse(BaseModel):
    """Stateless retrieval response contract."""

    results: list[MemoryRetrievalResult]
    request: MemoryRetrievalRequest = Field(...)


class MemoryStoreRequest(BaseModel):
    """Explicit manual memory write contract."""

    action: Literal["store"] = "store"
    cwd: str
    text: str
    summary: str | None = None
    tags: list[str] = Field(default_factory=list)
    scope: Literal["project", "user"] = "project"

    @field_validator("text")
    @classmethod
    def _validate_text(cls, value: str):
        value = value.strip()
        if not value:
            raise ValueError("text must not be empty")
        return value


class MemoryStoreResponse(BaseModel):
    """Compact write result contract."""

    ok: bool = True
    project: str
    scope: MemoryScope
    scope_id: str
    path: str
    summary: str | None = None


class SessionCaptureRequest(BaseModel):
    """Pi extension request contract for thresholded session capture."""

    action: Literal["session_capture"] = "session_capture"
    cwd: str
    session_id: str
    transcript_path: str
    transcript_bytes: int | None = None
    message_count: int | None = None
    agent: str | None = None
    model: str | None = None
    event: str | None = None
    final: bool = False
    idle: bool = False
    summary_only: bool = True
    metadata: dict[str, str | int | bool | None] = Field(default_factory=dict)


class SessionCaptureResponse(BaseModel):
    """Compact response for a session capture checkpoint/flush request."""

    ok: bool = True
    action: Literal["session_capture"] = "session_capture"
    session_id: str
    result: Literal["skipped", "captured", "flushed"]
    reason: str | None = None
    project: str | None = None
    turns_seen: int = 0
    new_turns: int = 0
    pending_turns: int = 0
    checkpoint_offset: int = 0
    flushed_count: int = 0
