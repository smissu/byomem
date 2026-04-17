"""RED retrieval tests for the stateless memory seam."""

from core.models import MemoryRecord, MemoryRetrievalRequest


def test_retrieval_ranks_best_matching_project_record_first(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embeddings_batch", return_value=[([0.1, 0.1], True)])
    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.1, 0.1])
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="r1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r2", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="beta only", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r3", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="completely unrelated", source_kind="pi_native_store"))

    request = MemoryRetrievalRequest(query="beta gamma", scope="project", filters={"project": project_id, "lifecycle": ["active"]})
    response = retrieve_memory(request)
    assert [result.record.content for result in response.results][:2] == ["alpha beta gamma", "beta only"]
    assert all("candidate_source=" in result.provenance for result in response.results)
    assert all("semantic_rerank=" in result.provenance for result in response.results)


def test_retrieval_lexical_only_semantic_unavailable(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=None)

    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="p1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="project note about alpha beta", source_kind="pi_native_store"))

    request = MemoryRetrievalRequest(query="alpha beta", scope="project", filters={"project": project_id, "lifecycle": ["active"]})
    response = retrieve_memory(request)
    assert response.results
    assert response.results[0].reason == "fts lexical match (semantic unavailable)"
    assert "semantic_available=false" in response.results[0].provenance
    assert "semantic_rerank=false" in response.results[0].provenance


def test_retrieval_semantic_rerank_applied(tmp_path):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    embed_map = {
        "alpha beta gamma": [0.95, 0.05],
        "beta only": [0.99, 0.01],
        "completely unrelated": [0.1, 0.9],
    }
    from core import native_memory_index as nmi

    nmi._get_embedding = lambda db, text, text_hash: [0.99, 0.01]
    nmi._get_embeddings_batch = lambda db, texts, hashes, **kw: [(embed_map[text], True) for text in texts]

    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="r1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r2", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="beta only", source_kind="pi_native_store"))

    request = MemoryRetrievalRequest(query="beta gamma", scope="project", filters={"project": project_id, "lifecycle": ["active"]})
    response = retrieve_memory(request)
    assert [result.record.content for result in response.results] == ["alpha beta gamma", "beta only"]
    assert all(result.reason in {"fts lexical match with semantic rerank", "hybrid lexical + semantic recall"} for result in response.results)
    assert all("semantic_score=" in result.provenance for result in response.results)


def test_retrieval_does_not_cross_project_user_scope(tmp_path, monkeypatch):
    from core.memory_identity import resolve_project_id, resolve_user_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    from core import native_memory_index as nmi
    nmi._get_embeddings_batch = lambda db, texts, hashes, **kw: [([0.1, 0.1], True) for _ in texts]
    nmi._get_embedding = lambda db, text, text_hash: [0.1, 0.1]
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    user_id = resolve_user_id()
    store.write(MemoryRecord(id="p1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="project note", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="u1", scope="user", scope_id=user_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="user note", source_kind="pi_native_store"))

    request = MemoryRetrievalRequest(query="note", scope="project", filters={"project": project_id, "lifecycle": ["active"]})
    response = retrieve_memory(request)
    assert all(result.record.scope == "project" for result in response.results)


def test_retrieval_semantic_only_recall_identifies_non_fts_path(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.9, 0.1])

    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="s1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="semantic only content", source_kind="pi_native_store"))

    response = retrieve_memory(MemoryRetrievalRequest(query="no fts hit here", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert response.results
    assert response.results[0].reason == "semantic-only recall beyond FTS gate"
    assert "candidate_source=semantic" in response.results[0].provenance
    assert "semantic_available=true" in response.results[0].provenance


def test_retrieval_merges_fts_and_semantic_candidates(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.8, 0.2])

    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="h1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta shared", source_kind="pi_native_store"))

    response = retrieve_memory(MemoryRetrievalRequest(query="alpha beta", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert response.results
    assert len({result.record.id for result in response.results}) == len(response.results)
    assert any(result.reason in {"hybrid lexical + semantic recall", "fts lexical match with semantic rerank"} for result in response.results)
    assert all(result.record.content != "completely unrelated" for result in response.results)


def test_retrieval_lexical_score_prefers_stronger_fts_hit(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=None)
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="a1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="a2", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta", source_kind="pi_native_store"))

    response = retrieve_memory(MemoryRetrievalRequest(query="alpha beta gamma", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert response.results[0].record.content == "alpha beta gamma"
    assert "lexical_score=" in response.results[0].provenance
    assert response.results[0].reason.startswith("fts lexical match")


def test_retrieval_lexical_score_absent_for_semantic_only(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.9, 0.1])
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="s1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="semantic only content", source_kind="pi_native_store"))

    response = retrieve_memory(MemoryRetrievalRequest(query="no fts hit here", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert response.results[0].reason == "semantic-only recall beyond FTS gate"
    assert "lexical_score=0.0000" in response.results[0].provenance


def test_pi_adapter_preserves_rank_order_with_real_lexical_scoring(tmp_path, mocker):
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    mocker.patch("core.native_memory_index._get_embedding", return_value=None)
    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "team-a" / "shared"
    cwd.mkdir(parents=True)
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "alpha beta gamma", "scope": "project"})
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "alpha beta", "scope": "project"})

    response = handle_pi_request({"query": "alpha beta gamma", "cwd": str(cwd)})
    assert [item["text"] for item in response["items"]][:2] == ["alpha beta gamma", "alpha beta"]
