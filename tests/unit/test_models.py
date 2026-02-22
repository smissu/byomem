"""Tests for core.models Pydantic models."""

import json

import pytest
from pydantic import ValidationError

from core.models import (
    BatchSummaryItem,
    BatchSummaryResponse,
    QueueJob,
    Turn,
    TurnSummary,
)

# --- Turn ---


def test_turn_minimal():
    """Turn requires only id; other fields default to empty strings."""
    t = Turn(id="abc123")
    assert t.id == "abc123"
    assert t.timestamp == ""
    assert t.user == ""
    assert t.assistant == ""


def test_turn_all_fields():
    t = Turn(
        id="t1",
        timestamp="2026-02-19T10:00:00",
        user="hello",
        assistant="hi there",
    )
    assert t.id == "t1"
    assert t.timestamp == "2026-02-19T10:00:00"
    assert t.user == "hello"
    assert t.assistant == "hi there"


def test_turn_missing_id_raises():
    with pytest.raises(ValidationError):
        Turn()


def test_turn_model_dump():
    t = Turn(id="t1", user="q")
    d = t.model_dump()
    assert d == {"id": "t1", "timestamp": "", "user": "q", "assistant": ""}


# --- TurnSummary ---


def test_turn_summary_defaults():
    ts = TurnSummary()
    assert ts.title == "Session turn"
    assert ts.summary == ""
    assert ts.classification == "general"
    assert ts.important is False
    assert ts.milestone is False


def test_turn_summary_all_fields():
    ts = TurnSummary(
        title="Added auth",
        summary="Implemented OAuth2 flow",
        classification="feature",
        important=True,
        milestone=True,
    )
    assert ts.title == "Added auth"
    assert ts.summary == "Implemented OAuth2 flow"
    assert ts.classification == "feature"
    assert ts.important is True
    assert ts.milestone is True


@pytest.mark.parametrize(
    "classification",
    ["fix", "decision", "feature", "research", "general"],
)
def test_turn_summary_valid_classifications(classification):
    ts = TurnSummary(classification=classification)
    assert ts.classification == classification


def test_turn_summary_invalid_classification():
    with pytest.raises(ValidationError):
        TurnSummary(classification="invalid")


def test_turn_summary_model_dump():
    ts = TurnSummary(title="Bug fix", classification="fix", important=True)
    d = ts.model_dump()
    assert d == {
        "title": "Bug fix",
        "summary": "",
        "classification": "fix",
        "important": True,
        "milestone": False,
    }


# --- BatchSummaryItem ---


def test_batch_summary_item_requires_turn_id():
    with pytest.raises(ValidationError):
        BatchSummaryItem()


def test_batch_summary_item_minimal():
    item = BatchSummaryItem(turn_id="t1")
    assert item.turn_id == "t1"
    # Inherits TurnSummary defaults
    assert item.title == "Session turn"
    assert item.classification == "general"
    assert item.important is False


def test_batch_summary_item_all_fields():
    item = BatchSummaryItem(
        turn_id="t42",
        title="Refactored parser",
        summary="Rewrote JSONL parser for clarity",
        classification="fix",
        important=True,
        milestone=False,
    )
    assert item.turn_id == "t42"
    assert item.title == "Refactored parser"
    assert item.summary == "Rewrote JSONL parser for clarity"
    assert item.classification == "fix"
    assert item.important is True
    assert item.milestone is False


def test_batch_summary_item_inherits_turn_summary():
    assert issubclass(BatchSummaryItem, TurnSummary)


def test_batch_summary_item_model_dump_includes_turn_id():
    item = BatchSummaryItem(turn_id="t1", classification="decision")
    d = item.model_dump()
    assert "turn_id" in d
    assert d["turn_id"] == "t1"
    assert d["classification"] == "decision"


# --- BatchSummaryResponse ---


def test_batch_summary_response_empty():
    resp = BatchSummaryResponse(summaries=[])
    assert resp.summaries == []


def test_batch_summary_response_with_items():
    items = [
        BatchSummaryItem(turn_id="t1", title="First"),
        BatchSummaryItem(turn_id="t2", title="Second", classification="feature"),
    ]
    resp = BatchSummaryResponse(summaries=items)
    assert len(resp.summaries) == 2
    assert resp.summaries[0].turn_id == "t1"
    assert resp.summaries[1].classification == "feature"


def test_batch_summary_response_requires_summaries():
    with pytest.raises(ValidationError):
        BatchSummaryResponse()


def test_batch_summary_response_rejects_wrong_type():
    with pytest.raises(ValidationError):
        BatchSummaryResponse(summaries=["not", "items"])


# --- QueueJob ---


def test_queue_job_minimal():
    job = QueueJob(session_id="s1", transcript_path="/tmp/t.jsonl")
    assert job.session_id == "s1"
    assert job.transcript_path == "/tmp/t.jsonl"
    assert job.cwd == ""
    assert job.model_override is None
    assert job.created_at == ""  # default is empty string


def test_queue_job_all_fields():
    job = QueueJob(
        session_id="sess-42",
        transcript_path="/data/log.jsonl",
        cwd="/home/user/project",
        model_override="claude-3-haiku-20240307",
        created_at="2026-02-19T12:00:00",
    )
    assert job.session_id == "sess-42"
    assert job.transcript_path == "/data/log.jsonl"
    assert job.cwd == "/home/user/project"
    assert job.model_override == "claude-3-haiku-20240307"
    assert job.created_at == "2026-02-19T12:00:00"


def test_queue_job_missing_required_fields():
    with pytest.raises(ValidationError):
        QueueJob()

    with pytest.raises(ValidationError):
        QueueJob(session_id="s1")

    with pytest.raises(ValidationError):
        QueueJob(transcript_path="/tmp/t.jsonl")


def test_queue_job_model_dump_json_roundtrip():
    job = QueueJob(
        session_id="s1",
        transcript_path="/tmp/t.jsonl",
        cwd="/proj",
        created_at="2026-02-19T12:00:00",
    )
    json_str = job.model_dump_json()
    parsed = json.loads(json_str)
    assert parsed["session_id"] == "s1"
    assert parsed["transcript_path"] == "/tmp/t.jsonl"
    assert parsed["cwd"] == "/proj"
    assert parsed["model_override"] is None
    assert parsed["created_at"] == "2026-02-19T12:00:00"


def test_queue_job_model_validate_json():
    raw = json.dumps(
        {
            "session_id": "s2",
            "transcript_path": "/data/x.jsonl",
            "cwd": "/work",
            "model_override": "haiku",
            "created_at": "2026-02-19T14:00:00",
        }
    )
    job = QueueJob.model_validate_json(raw)
    assert job.session_id == "s2"
    assert job.transcript_path == "/data/x.jsonl"
    assert job.cwd == "/work"
    assert job.model_override == "haiku"
    assert job.created_at == "2026-02-19T14:00:00"


def test_queue_job_json_roundtrip():
    """Serialize to JSON and deserialize back; objects should be equal."""
    original = QueueJob(
        session_id="rt1",
        transcript_path="/tmp/rt.jsonl",
        cwd="/roundtrip",
        model_override="sonnet",
        created_at="2026-02-19T15:30:00",
    )
    restored = QueueJob.model_validate_json(original.model_dump_json())
    assert restored == original


def test_queue_job_model_override_none_by_default():
    job = QueueJob(session_id="s1", transcript_path="/tmp/t.jsonl")
    d = job.model_dump()
    assert d["model_override"] is None
