"""Pydantic models for structured data flow throughout byomem."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


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
