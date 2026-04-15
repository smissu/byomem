"""Foundation contract tests for Pi/byomem memory models and retrieval shapes.

These tests intentionally define the tranche-1 RED state for the builder.
"""

import pytest
from pydantic import ValidationError

from core.models import (
    MemoryRecord,
    MemoryRetrievalRequest,
    MemoryRetrievalResponse,
    MemoryRetrievalResult,
)


@pytest.mark.parametrize("scope", ["project", "dir", "user", "agent"])
def test_memory_record_accepts_canonical_scopes(scope):
    record = MemoryRecord(
        id="mem_1",
        scope=scope,
        scope_id=f"{scope}-repo-a",
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T01:00:00Z",
        source="notes.md",
        content="Canonical memory content",
    )
    assert record.scope == scope
    assert record.scope_id == f"{scope}-repo-a"
    assert record.created_at == "2026-04-15T00:00:00Z"
    assert record.updated_at == "2026-04-15T01:00:00Z"
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
        scope_id="project-repo-a",
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T01:00:00Z",
        source="notes.md",
        content="Lifecycle content",
        lifecycle=lifecycle,
    )
    assert record.lifecycle == lifecycle


def test_memory_record_defaults_lifecycle_to_active():
    record = MemoryRecord(
        id="mem_3",
        scope="user",
        scope_id="user-repo-a",
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T00:00:00Z",
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
        {"scope": "project", "scope_id": "repo-a", "created_at": "2026-04-15T00:00:00Z", "updated_at": "2026-04-15T01:00:00Z", "source": "notes.md", "content": "missing id"},
        {"id": "mem_4", "scope_id": "repo-a", "created_at": "2026-04-15T00:00:00Z", "updated_at": "2026-04-15T01:00:00Z", "source": "notes.md", "content": "missing scope"},
        {"id": "mem_4", "scope": "project", "created_at": "2026-04-15T00:00:00Z", "updated_at": "2026-04-15T01:00:00Z", "source": "notes.md", "content": "missing scope_id"},
        {"id": "mem_4", "scope": "project", "scope_id": "repo-a", "updated_at": "2026-04-15T01:00:00Z", "source": "notes.md", "content": "missing created_at"},
        {"id": "mem_4", "scope": "project", "scope_id": "repo-a", "created_at": "2026-04-15T00:00:00Z", "source": "notes.md", "content": "missing updated_at"},
        {"id": "mem_4", "scope": "project", "scope_id": "repo-a", "created_at": "2026-04-15T00:00:00Z", "updated_at": "2026-04-15T01:00:00Z", "source": "notes.md"},
    ],
)
def test_memory_record_missing_required_storage_fields_rejected(payload):
    with pytest.raises(ValidationError):
        MemoryRecord(**payload)


def test_memory_record_round_trips_optional_storage_metadata():
    record = MemoryRecord(
        id="mem_opt",
        scope="project",
        scope_id="repo-a",
        created_at="2026-04-15T00:00:00Z",
        updated_at="2026-04-15T01:00:00Z",
        expires_at="2026-05-01T00:00:00Z",
        tags=["release", "decision"],
        source_kind="main_md",
        source_ref="main.md",
        source="notes.md",
        content="Optional metadata",
    )
    assert record.expires_at == "2026-05-01T00:00:00Z"
    assert record.tags == ["release", "decision"]
    assert record.source_kind == "main_md"
    assert record.source_ref == "main.md"


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


def test_memory_retrieval_response_round_trips_result_wrapper_shape():
    response = MemoryRetrievalResponse(
        results=[
            {
                "record": {
                    "id": "mem_1",
                    "scope": "project",
                    "scope_id": "repo-a",
                    "created_at": "2026-04-15T00:00:00Z",
                    "updated_at": "2026-04-15T01:00:00Z",
                    "source": "notes.md",
                    "content": "Result content",
                    "lifecycle": "active",
                },
                "reason": "scope/lifecycle match",
                "provenance": "notes.md#mem_1",
            }
        ],
        request={
            "query": "find this",
            "scope": "project",
            "filters": {"project": "repo-a"},
        },
    )
    assert isinstance(response.results[0], MemoryRetrievalResult)
    assert response.results[0].record.id == "mem_1"
    assert response.results[0].reason == "scope/lifecycle match"
    assert response.results[0].provenance == "notes.md#mem_1"
    assert response.request.scope == "project"
