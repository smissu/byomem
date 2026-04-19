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


def test_retrieval_survives_in_process_reset_and_reloads_persisted_native_store(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=None)
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    record = MemoryRecord(
        id="durable-1",
        scope="project",
        scope_id=project_id,
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:store",
        content="durable native record",
        source_kind="pi_native_store",
    )
    store.write(record)

    reset_native_store(tmp_path / ".byomem" / "native")
    response = retrieve_memory(MemoryRetrievalRequest(query="durable native", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))

    assert response.results
    assert response.results[0].record == record
    assert response.results[0].record.content == "durable native record"
    assert "records.jsonl" in str(store.path)
    assert all(".md" not in result.provenance for result in response.results)


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


def test_retrieval_lexical_score_prefers_stronger_fts_hit(tmp_path, mocker):
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


def test_retrieval_prefers_stable_identity_within_scope(tmp_path, monkeypatch):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    store = reset_native_store(tmp_path / ".byomem" / "native")
    repo_a = tmp_path / "team-a" / "shared"
    repo_b = tmp_path / "team-b" / "shared"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)
    project_a = resolve_project_id(str(repo_a))
    project_b = resolve_project_id(str(repo_b))
    record_a = MemoryRecord(id="shared-note", scope="project", scope_id=project_a, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="stable identity alpha", source_kind="pi_native_store")
    record_b = MemoryRecord(id="shared-note", scope="project", scope_id=project_b, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="stable identity beta", source_kind="pi_native_store")
    store.write(record_a)
    store.write(record_b)

    response_a = retrieve_memory(MemoryRetrievalRequest(query="stable identity", scope="project", filters={"project": project_a, "lifecycle": ["active"]}))
    response_b = retrieve_memory(MemoryRetrievalRequest(query="stable identity", scope="project", filters={"project": project_b, "lifecycle": ["active"]}))

    assert response_a.results
    assert response_b.results
    assert response_a.results[0].record.scope_id == project_a
    assert response_b.results[0].record.scope_id == project_b
    assert response_a.results[0].record.id == "shared-note"
    assert response_b.results[0].record.id == "shared-note"


def test_retrieval_records_native_provenance_and_avoids_markdown_backing(tmp_path, monkeypatch):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.memory_store import reset_native_store

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    store.write(MemoryRecord(id="native-1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:session_capture", source_kind="session_capture_summary", source_ref="session:sess-1:turn:t-1", content="native provenance content", lifecycle="active"))

    response = retrieve_memory(MemoryRetrievalRequest(query="native provenance", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))

    assert response.results
    assert response.results[0].record.source == "pi:session_capture"
    assert response.results[0].record.source_kind == "session_capture_summary"
    assert response.results[0].record.source_ref == "session:sess-1:turn:t-1"
    assert ".md" not in response.results[0].provenance


def test_retrieval_hydrates_identity_candidates_that_arrive_as_memory_records(tmp_path, monkeypatch):
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import fetch_candidates, retrieve_memory
    from core.memory_store import reset_native_store
    from core.native_memory_index import search_native_records

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    monkeypatch.setattr("core.native_memory_index._get_embedding", lambda db, text, text_hash: None)

    store = reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    project_id = resolve_project_id(str(cwd))
    record = MemoryRecord(id="identity-1", scope="project", scope_id=project_id, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="identity hydration target", source_kind="pi_native_store")
    store.write(record)

    candidates = fetch_candidates(MemoryRetrievalRequest(query="identity hydration", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert candidates
    assert any(isinstance(candidate, dict) and isinstance(candidate.get("record"), MemoryRecord) for candidate in candidates)
    response = retrieve_memory(MemoryRetrievalRequest(query="identity hydration", scope="project", filters={"project": project_id, "lifecycle": ["active"]}))
    assert response.results[0].record.id == "identity-1"
    assert response.results[0].record.content == "identity hydration target"
