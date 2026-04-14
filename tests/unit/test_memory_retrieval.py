"""RED seam tests for the stateless retrieval adapter."""

from dataclasses import dataclass

import pytest

from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse


@dataclass(frozen=True)
class PersistedArtifactFixture:
    source_kind: str
    path: str
    scope: str
    lifecycle: str = "active"
    content: str = "persisted content"


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


@pytest.mark.parametrize(
    "candidate_scope, should_keep",
    [
        ("project", True),
        ("dir", False),
        ("user", False),
        ("agent", False),
    ],
)
def test_retrieval_returns_only_candidates_matching_request_scope(monkeypatch, candidate_scope, should_keep):
    from core import memory_retrieval

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived", "superseded"]},
    )

    candidate = MemoryRecord(
        id=f"mem_{candidate_scope}",
        scope=candidate_scope,
        source=f"{candidate_scope}.md",
        content="mixed scope candidate",
    )

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: [candidate])

    response = memory_retrieval.retrieve_memory(request)

    if should_keep:
        assert [r.id for r in response.results] == [candidate.id]
    else:
        assert response.results == []


def test_retrieval_filters_mixed_scope_backend_batches(monkeypatch):
    from core import memory_retrieval

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived", "superseded"]},
    )

    candidates = [
        MemoryRecord(id="project-1", scope="project", source="p.md", content="keep me"),
        MemoryRecord(id="dir-1", scope="dir", source="d.md", content="drop me"),
        MemoryRecord(id="user-1", scope="user", source="u.md", content="drop me"),
        MemoryRecord(id="agent-1", scope="agent", source="a.md", content="drop me"),
    ]

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: candidates)

    response = memory_retrieval.retrieve_memory(request)

    assert [r.scope for r in response.results] == ["project"]
    assert [r.id for r in response.results] == ["project-1"]


@pytest.mark.parametrize("scope", ["project", "dir", "user", "agent"])
def test_retrieval_keeps_lifecycle_defaults_intact_while_filtering_by_request_scope(monkeypatch, scope):
    from core import memory_retrieval

    candidate = MemoryRecord(
        id="mem_active",
        scope=scope,
        source="notes.md",
        content="candidate content",
    )
    assert candidate.lifecycle == "active"

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: [candidate])

    request = MemoryRetrievalRequest(
        query="find release notes",
        scope=scope,
        filters={scope: f"{scope}-a", "lifecycle": ["active"]},
    )

    response = memory_retrieval.retrieve_memory(request)

    assert response.results[0].lifecycle == "active"
    assert response.request == request


def test_retrieval_includes_compact_reason_metadata_per_result(monkeypatch):
    from core import memory_retrieval

    candidate = MemoryRecord(id="main-1", scope="project", source="main.md", content="keep me", lifecycle="active")
    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: [candidate])

    request = MemoryRetrievalRequest(
        query="reason metadata",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active"]},
    )

    response = memory_retrieval.retrieve_memory(request)

    assert len(response.results) == 1
    assert response.results[0].record == candidate
    assert response.results[0].reason == "scope/lifecycle match"
    assert response.results[0].provenance == "main.md#main-1"


def test_retrieval_request_echo_and_stateless_behavior_remain_unchanged(monkeypatch):
    from core import memory_retrieval

    request = MemoryRetrievalRequest(
        query="echo me",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active"]},
    )

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda incoming: [])

    response = memory_retrieval.retrieve_memory(request)

    assert response.request == request
    assert response.results == []


def test_retrieval_assembles_candidates_from_persisted_artifacts_via_adapter(monkeypatch):
    from core import memory_retrieval

    fixtures = [
        PersistedArtifactFixture(source_kind="main_md", path="main.md", scope="project", content="main summary"),
        PersistedArtifactFixture(source_kind="branch_commit", path="branches/2026-04-14-abc12345/commit.md", scope="project", content="branch summary"),
        PersistedArtifactFixture(source_kind="branch_log", path="branches/2026-04-14-abc12345/log.md", scope="project", content="turn summary"),
    ]

    seen = {}

    def fake_assemble_candidates(request):
        seen["request"] = request
        return [
            MemoryRecord(id=f"{item.source_kind}-1", scope=item.scope, source=item.path, content=item.content)
            for item in fixtures
        ]

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", fake_assemble_candidates)

    request = MemoryRetrievalRequest(
        query="assembled from persisted artifacts",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived", "superseded"]},
    )

    response = memory_retrieval.retrieve_memory(request)

    assert seen["request"] == request
    assert [r.source for r in response.results] == ["main.md", "branches/2026-04-14-abc12345/commit.md", "branches/2026-04-14-abc12345/log.md"]
    assert [r.content for r in response.results] == ["main summary", "branch summary", "turn summary"]


def test_retrieval_preserves_request_scope_and_lifecycle_behavior_on_persisted_candidates(monkeypatch):
    from core import memory_retrieval

    candidates = [
        MemoryRecord(id="keep", scope="project", source="main.md", content="keep", lifecycle="active"),
        MemoryRecord(id="drop-scope", scope="dir", source="commit.md", content="drop", lifecycle="active"),
        MemoryRecord(id="drop-life", scope="project", source="log.md", content="drop", lifecycle="deleted"),
    ]

    monkeypatch.setattr(memory_retrieval, "fetch_candidates", lambda request: candidates)

    request = MemoryRetrievalRequest(
        query="request-driven",
        scope="project",
        filters={"project": "repo-a", "lifecycle": ["active", "archived", "superseded"]},
    )

    response = memory_retrieval.retrieve_memory(request)

    assert [r.id for r in response.results] == ["keep"]
    assert response.request == request
