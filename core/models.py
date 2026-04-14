"""Pydantic models for structured data flow throughout byomem.

This file contains the tranche-1 minimum contract only; later sprints may extend
these models, but should avoid breaking the base shape defined here.
"""

from __future__ import annotations

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
    source: str
    content: str
    lifecycle: MemoryLifecycle = "active"


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
        allowed_keys = {"project", "dir", "user", "agent", "lifecycle", "source"}
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
