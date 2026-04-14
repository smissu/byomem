"""RED seam tests for the minimal stateless retrieval adapter."""

import pytest

from core.models import MemoryRetrievalRequest, MemoryRetrievalResponse


def test_retrieval_adapter_round_trips_request_and_response_contract():
    from core.memory_retrieval import retrieve_memory

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active"]},
    )

    response = retrieve_memory(request)

    assert isinstance(response, MemoryRetrievalResponse)
    assert response.request == request
    assert response.results == []


def test_retrieval_adapter_rejects_missing_explicit_scope_or_filters():
    from core.memory_retrieval import retrieve_memory

    with pytest.raises(Exception):
        retrieve_memory(
            MemoryRetrievalRequest(
                query="find release notes",
                scope="project",
                filters={},
            )
        )
