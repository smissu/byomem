"""Foundation contract tests for Pi/byomem memory models and retrieval shapes.

These tests intentionally define the tranche-1 RED state for the builder.
"""

import pytest
from pydantic import ValidationError

from core.models import (
    MemoryRecord,
    MemoryRetrievalRequest,
    MemoryRetrievalResponse,
)


@pytest.mark.parametrize("scope", ["project", "dir", "user", "agent"])
def test_memory_record_accepts_canonical_scopes(scope):
    record = MemoryRecord(
        id="mem_1",
        scope=scope,
        source="notes.md",
        content="Canonical memory content",
    )
    assert record.scope == scope
    assert record.lifecycle == "active"


@pytest.mark.parametrize(
    "scope",
    ["session", "global", "workspace", "project:repo", "", None],
)
def test_memory_record_rejects_invalid_or_future_scopes(scope):
    with pytest.raises(ValidationError):
        MemoryRecord(
            id="mem_bad",
            scope=scope,
            source="notes.md",
            content="Should not validate",
        )


@pytest.mark.parametrize(
    "lifecycle",
    ["active", "superseded", "archived", "deleted", "expired"],
)
def test_memory_record_accepts_known_lifecycle_states(lifecycle):
    record = MemoryRecord(
        id="mem_2",
        scope="project",
        source="notes.md",
        content="Lifecycle content",
        lifecycle=lifecycle,
    )
    assert record.lifecycle == lifecycle


def test_memory_record_defaults_lifecycle_to_active():
    record = MemoryRecord(
        id="mem_3",
        scope="user",
        source="prefs.md",
        content="Defaults matter",
    )
    assert record.lifecycle == "active"


def test_memory_record_requires_core_fields():
    with pytest.raises(ValidationError):
        MemoryRecord()


@pytest.mark.parametrize(
    "payload",
    [
        {"scope": "project", "source": "notes.md", "content": "missing id"},
        {"id": "mem_4", "source": "notes.md", "content": "missing scope"},
        {"id": "mem_4", "scope": "project", "content": "missing source"},
        {"id": "mem_4", "scope": "project", "source": "notes.md"},
    ],
)
def test_memory_record_missing_core_fields_rejected(payload):
    with pytest.raises(ValidationError):
        MemoryRecord(**payload)


def test_memory_retrieval_request_requires_explicit_scope_and_filter_inputs():
    with pytest.raises(ValidationError):
        MemoryRetrievalRequest()

    with pytest.raises(ValidationError):
        MemoryRetrievalRequest(query="find this")

    with pytest.raises(ValidationError):
        MemoryRetrievalRequest(scope="project", filters={})

    with pytest.raises(ValidationError):
        MemoryRetrievalRequest(filters={"lifecycle": ["active"]})


def test_memory_retrieval_request_accepts_explicit_scope_and_filters():
    request = MemoryRetrievalRequest(
        query="find this",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived"]},
    )
    assert request.query == "find this"
    assert request.scope == "project"
    assert request.filters["project"] == "repo-a"


def test_memory_retrieval_request_rejects_unsupported_filter_keys():
    with pytest.raises(ValidationError):
        MemoryRetrievalRequest(
            query="find this",
            scope="project",
            filters={"unsupported": "value"},
        )


def test_memory_retrieval_response_requires_explicit_result_shape():
    with pytest.raises(ValidationError):
        MemoryRetrievalResponse()

    response = MemoryRetrievalResponse(
        results=[],
        request={"query": "find this", "scope": "project", "filters": {"project": "repo-a"}},
    )
    assert response.request.scope == "project"


def test_memory_retrieval_response_round_trips_canonical_result_shape():
    response = MemoryRetrievalResponse(
        results=[
            {
                "id": "mem_1",
                "scope": "project",
                "source": "notes.md",
                "content": "Result content",
                "lifecycle": "active",
            }
        ],
        request={
            "query": "find this",
            "scope": "project",
            "filters": {"project": "repo-a"},
        },
    )
    assert response.results[0].id == "mem_1"
    assert response.request.scope == "project"
