from core.models import MemoryRecord, MemoryRetrievalRequest


def _seed_eval_store(tmp_path):
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store

    store = reset_native_store(tmp_path / ".byomem" / "native")
    proj_a = resolve_project_id(str(tmp_path / "repo-a"))
    proj_b = resolve_project_id(str(tmp_path / "repo-b"))
    store.write(MemoryRecord(id="r-alpha", scope="project", scope_id=proj_a, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r-sem", scope="project", scope_id=proj_a, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="semantic only content", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r-shared", scope="project", scope_id=proj_b, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="shared note", source_kind="pi_native_store"))
    return proj_a, proj_b


def test_weight_config_changes_rank_order(tmp_path, mocker):
    from core.memory_retrieval import retrieve_memory, RETRIEVAL_WEIGHTS
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.8, 0.2])
    store = reset_native_store(tmp_path / ".byomem" / "native")
    proj = resolve_project_id(str(tmp_path / "repo-a"))
    store.write(MemoryRecord(id="r1", scope="project", scope_id=proj, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="r2", scope="project", scope_id=proj, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta", source_kind="pi_native_store"))
    RETRIEVAL_WEIGHTS.update({"semantic": 0.9, "lexical": 0.1})
    response = retrieve_memory(MemoryRetrievalRequest(query="alpha beta gamma", scope="project", filters={"project": proj, "lifecycle": ["active"]}))
    assert response.results


def test_eval_dataset_loader_parses(tmp_path):
    from core.retrieval_eval import load_eval_dataset
    path = tmp_path / "dataset.json"
    path.write_text('{"cases": [{"id": "c1", "category": "lexical_dominant", "note": "n", "query": "q", "scope": "project", "filters": {"project": "p", "lifecycle": ["active"]}, "relevant_ids": ["r"], "irrelevant_ids": ["x"]}]}')
    cases = load_eval_dataset(path)
    assert len(cases) == 1
    assert cases[0].query == "q"


def test_eval_runner_deterministic_metrics(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store
    from core.retrieval_eval import EvalCase, evaluate_retrieval_cases

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.8, 0.2])
    store = reset_native_store(tmp_path / ".byomem" / "native")
    proj = resolve_project_id(str(tmp_path / "repo-a"))
    store.write(MemoryRecord(id="r-alpha", scope="project", scope_id=proj, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha beta gamma", source_kind="pi_native_store"))
    cases = [EvalCase(query="alpha beta gamma", scope="project", filters={"project": proj, "lifecycle": ["active"]}, relevant_ids=["r-alpha"])]
    metrics1 = evaluate_retrieval_cases(cases, weights={"semantic": 0.65, "lexical": 0.35})
    metrics2 = evaluate_retrieval_cases(cases, weights={"semantic": 0.65, "lexical": 0.35})
    assert metrics1 == metrics2


def test_eval_runner_is_scope_stable_and_non_bleeding(tmp_path, mocker):
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store
    from core.retrieval_eval import EvalCase, evaluate_retrieval_cases

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.7, 0.3])
    store = reset_native_store(tmp_path / ".byomem" / "native")
    proj_a = resolve_project_id(str(tmp_path / "repo-a"))
    proj_b = resolve_project_id(str(tmp_path / "repo-b"))
    store.write(MemoryRecord(id="shared", scope="project", scope_id=proj_a, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="alpha scope", source_kind="pi_native_store"))
    store.write(MemoryRecord(id="shared", scope="project", scope_id=proj_b, created_at="2026-01-01T00:00:00Z", updated_at="2026-01-01T00:00:00Z", source="pi:store", content="beta scope", source_kind="pi_native_store"))

    metrics_a = evaluate_retrieval_cases([EvalCase(query="alpha scope", scope="project", filters={"project": proj_a, "lifecycle": ["active"]}, relevant_ids=["shared"])], weights={"semantic": 0.65, "lexical": 0.35})
    metrics_b = evaluate_retrieval_cases([EvalCase(query="beta scope", scope="project", filters={"project": proj_b, "lifecycle": ["active"]}, relevant_ids=["shared"])], weights={"semantic": 0.65, "lexical": 0.35})

    assert metrics_a["mrr"] == metrics_b["mrr"] == 1.0
    assert metrics_a["top1"] == metrics_b["top1"] == 1.0
    assert metrics_a["top3"] == metrics_b["top3"] == 1.0
    assert metrics_a["results"][0]["rank"] == metrics_b["results"][0]["rank"] == 1
    assert metrics_a["results"][0]["relevant_ids"] == metrics_b["results"][0]["relevant_ids"] == ["shared"]
