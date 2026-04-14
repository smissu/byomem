"""RED seam tests for the stateless retrieval adapter."""

import pytest

from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse


@pytest.mark.parametrize("scope", ["project", "dir", "user", "agent"])
def test_retrieval_adapter_honors_explicit_scope(scope):
    from core.memory_retrieval import retrieve_memory

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope=scope,
        filters={scope: f"{scope}-a", "lifecycle": ["active"]},
    )

    response = retrieve_memory(request)

    assert isinstance(response, MemoryRetrievalResponse)
    assert response.request == request
    assert response.results == []


@pytest.mark.parametrize(
    "lifecycle, included",
    [
        ("active", True),
        ("deleted", False),
        ("expired", False),
        ("archived", True),
        ("superseded", True),
    ],
)
def test_retrieval_adapter_lifecycle_filtering_contract(monkeypatch, lifecycle, included):
    from core import memory_retrieval

    candidates = [
        MemoryRecord(
            id="mem_1",
            scope="project",
            source="notes.md",
            content="candidate content",
            lifecycle=lifecycle,
        )
    ]

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: candidates)

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived", "superseded"]},
    )

    response = memory_retrieval.retrieve_memory(request)

    assert isinstance(response, MemoryRetrievalResponse)
    if included:
        assert len(response.results) == 1
        assert response.results[0].lifecycle == lifecycle
    else:
        assert response.results == []


@pytest.mark.parametrize("scope", ["project", "dir", "user", "agent"])
def test_retrieval_adapter_scope_specific_results_require_explicit_request_inputs(monkeypatch, scope):
    from core import memory_retrieval

    seen = {}

    def fake_fetch_candidates(request):
        seen["request"] = request
        return []

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", fake_fetch_candidates)

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope=scope,
        filters={scope: f"{scope}-a", "lifecycle": ["active"]},
    )

    memory_retrieval.retrieve_memory(request)

    assert seen["request"] == request


@pytest.mark.parametrize(
    "request_kwargs",
    [
        {"query": "find release notes", "scope": "project", "filters": {"project": "repo-a"}},
        {"query": "find release notes", "scope": "dir", "filters": {"dir": "src"}},
    ],
)
def test_retrieval_adapter_rejects_hidden_state_dependence(request_kwargs):
    from core.memory_retrieval import retrieve_memory

    request = MemoryRetrievalRequest(**request_kwargs)

    response = retrieve_memory(request)

    assert response.request == request
    assert response.results == []
