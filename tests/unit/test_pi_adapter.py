"""RED tests for the read-only Pi adapter."""

from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse, MemoryRetrievalResult


def test_pi_adapter_maps_query_cwd_to_project_retrieval(mocker, tmp_path):
    from core.memory_identity import resolve_project_id
    from core.pi_adapter import handle_pi_request

    captured = {}

    def fake_retrieve(request):
        captured["request"] = request
        return MemoryRetrievalResponse(
            request=request,
            results=[
                MemoryRetrievalResult(
                    record=MemoryRecord(
                        id="m1",
                        scope="project",
                        scope_id=request.filters["project"],
                        created_at="2026-01-01T00:00:00Z",
                        updated_at="2026-01-01T00:00:00Z",
                        source="main.md",
                        content="Fix stop order behavior.",
                    )
                )
            ],
        )

    mocker.patch("core.pi_adapter.retrieve_memory", side_effect=fake_retrieve)

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    response = handle_pi_request({"query": "stop order", "cwd": str(cwd), "max_results": 3})

    req = captured["request"]
    assert isinstance(req, MemoryRetrievalRequest)
    assert req.scope == "project"
    assert req.filters["project"] == resolve_project_id(str(cwd))
    assert response["summary"] == "1 item found"
    assert response["items"][0]["text"] == "Fix stop order behavior."


def test_pi_adapter_project_store_and_ranked_read_round_trip(tmp_path):
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "team-a" / "shared"
    cwd.mkdir(parents=True)
    project_id = resolve_project_id(str(cwd))

    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "alpha beta gamma", "scope": "project"})
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "beta only", "scope": "project"})
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "completely unrelated", "scope": "project"})

    read_response = handle_pi_request({"query": "beta gamma", "cwd": str(cwd)})
    assert [item["text"] for item in read_response["items"]][:2] == ["alpha beta gamma", "beta only"]
    assert all(item["source"] == "pi:store" for item in read_response["items"])
    assert resolve_project_id(str(cwd)) == project_id


def test_pi_adapter_exposes_lexical_only_semantic_unavailable(tmp_path, mocker):
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    mocker.patch("core.native_memory_index._get_embedding", return_value=None)

    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "team-a" / "shared"
    cwd.mkdir(parents=True)
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "alpha beta gamma", "scope": "project"})

    response = handle_pi_request({"query": "alpha beta", "cwd": str(cwd)})
    assert response["items"]


def test_pi_adapter_hybrid_ranking_contract_unchanged(tmp_path, mocker):
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.8, 0.2])

    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "team-a" / "shared"
    cwd.mkdir(parents=True)
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "alpha beta shared", "scope": "project"})

    response = handle_pi_request({"query": "alpha beta", "cwd": str(cwd)})
    assert response["items"]
    assert isinstance(response["items"][0]["text"], str)


def test_pi_adapter_empty_or_stopword_query_returns_empty(tmp_path):
    from core.pi_adapter import handle_pi_request

    response = handle_pi_request({"query": "", "cwd": str(tmp_path / "team-a" / "shared")})
    assert response == {"items": [], "summary": "No matching memory items found"}


def test_pi_adapter_writes_observability_logs(tmp_path, monkeypatch):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    monkeypatch.setenv("BYOMEM_DEBUG", "1")
    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "debug note", "scope": "project"})
    handle_pi_request({"query": "debug", "cwd": str(cwd)})

    log_path = cfg.queue_path / "byomem_adapter_debug.jsonl"
    assert log_path.exists()
    lines = log_path.read_text().strip().splitlines()
    assert any('"event": "start"' in line for line in lines)
    assert any('"event": "complete"' in line for line in lines)
    assert any('"correlation_id"' in line for line in lines)
    assert all('debug note' not in line or 'text_preview' in line for line in lines)


def test_pi_adapter_store_failure_logs_error(tmp_path, monkeypatch):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    monkeypatch.setenv("BYOMEM_DEBUG", "1")
    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    try:
        handle_pi_request({"action": "store", "cwd": str(cwd), "text": "debug note", "summary": 123})
    except ValueError:
        pass
    log_path = cfg.queue_path / "byomem_adapter_debug.jsonl"
    assert log_path.exists()
    assert '"event": "failure"' in log_path.read_text()

def test_pi_adapter_project_identity_does_not_collide_across_same_leaf_names(tmp_path):
    from core.memory_identity import resolve_project_id
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    reset_native_store(tmp_path / ".byomem" / "native")
    repo_a = tmp_path / "team-a" / "shared"
    repo_b = tmp_path / "team-b" / "shared"
    repo_a.mkdir(parents=True)
    repo_b.mkdir(parents=True)

    id_a = resolve_project_id(str(repo_a))
    id_b = resolve_project_id(str(repo_b))
    assert id_a != id_b

    handle_pi_request({"action": "store", "cwd": str(repo_a), "text": "note A", "scope": "project"})
    handle_pi_request({"action": "store", "cwd": str(repo_b), "text": "note B", "scope": "project"})

    response_a = handle_pi_request({"query": "note A", "cwd": str(repo_a)})
    response_b = handle_pi_request({"query": "note B", "cwd": str(repo_b)})
    assert response_a["items"][0]["text"] == "note A"
    assert response_b["items"][0]["text"] == "note B"


def test_pi_adapter_user_scope_store_and_read_round_trip(tmp_path, monkeypatch):
    from core.memory_identity import resolve_user_id
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    monkeypatch.setenv("BYOMEM_USER_ID", "alice")
    reset_native_store(tmp_path / ".byomem" / "native")

    user_id = resolve_user_id()
    store_response = handle_pi_request({"action": "store", "cwd": str(tmp_path / "repo-a"), "text": "user note", "scope": "user"})
    assert store_response["scope"] == "user"
    assert store_response["scope_id"] == user_id

    read_response = handle_pi_request({"query": "user note", "cwd": str(tmp_path / "repo-a"), "scope": "user"})
    assert read_response["items"]
    assert read_response["items"][0]["text"] == "user note"


def test_pi_adapter_does_not_depend_on_claude_memory_md(tmp_path):
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    claude_memory = tmp_path / ".claude" / "projects" / "repo-a" / "memory" / "MEMORY.md"
    claude_memory.parent.mkdir(parents=True)
    claude_memory.write_text("legacy only")

    handle_pi_request({"action": "store", "cwd": str(cwd), "text": "native only", "scope": "project"})
    response = handle_pi_request({"query": "native only", "cwd": str(cwd)})

    assert response["items"][0]["text"] == "native only"
    assert all(item["text"] != "legacy only" for item in response["items"])


def test_pi_adapter_store_rejects_non_string_summary(mocker):
    from core.pi_adapter import handle_pi_request

    for bad_summary in (123, False, [], {}):
        try:
            handle_pi_request({"action": "store", "cwd": "/tmp/byomem/app", "text": "Remember this", "summary": bad_summary})
        except ValueError as exc:
            assert "summary must be a string or null" in str(exc)
        else:
            raise AssertionError("expected ValueError")


def test_pi_adapter_capture_candidate_and_approval_flow(tmp_path):
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    reset_native_store(tmp_path / ".byomem" / "native")
    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    candidate_response = handle_pi_request({"action": "capture_candidate", "cwd": str(cwd), "outcome": "Fixed the blocker in project sync"})
    assert candidate_response["candidate"]["scope"] == "project"
    approval = handle_pi_request({"action": "approve_capture", "cwd": str(cwd), "candidate": candidate_response["candidate"], "approved": True})
    assert approval["stored"] is True
    read_response = handle_pi_request({"query": "blocker", "cwd": str(cwd)})
    assert read_response["items"]


def test_pi_adapter_session_capture_checkpoints_then_flushes(tmp_path, monkeypatch):
    import core.session_capture as session_capture
    from core.config import Config
    from core.pi_adapter import handle_pi_request

    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True, session_capture_threshold_turns=4, session_capture_min_turns=1)
    monkeypatch.setattr("core.config._config", cfg)
    monkeypatch.setattr("core.session_capture.get_config", lambda: cfg)

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        "\n".join([
            '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}',
            '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}',
            '{"type":"user","uuid":"u2","message":{"content":"q2"},"timestamp":"2026-01-01T00:01:00"}',
            '{"type":"assistant","uuid":"a2","parentUUID":"u2","message":{"content":"r2"},"timestamp":"2026-01-01T00:01:01"}',
        ]) + "\n"
    )

    summarized_batches = []
    monkeypatch.setattr(session_capture, "summarize_batch", lambda turns: summarized_batches.append([t.id for t in turns]) or [session_capture.TurnSummary(title=f"Summary {t.id}", summary=f"Did {t.id}", classification="general", important=True, milestone=False) for t in turns])

    captured = handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-1", "transcript_path": str(transcript), "event": "agent_end", "final": False, "idle": False, "summary_only": True, "message_count": 4})
    main_path = cfg.byomem / tmp_path.name / "main.md"
    project_memory_path = tmp_path / ".claude" / "projects" / f"-{str(tmp_path).replace('/', '-')}-repo-a" / "memory" / "MEMORY.md"
    assert not main_path.exists()
    assert not project_memory_path.exists()
    assert captured["result"] == "captured"
    assert captured["reason"] == "checkpointed"
    assert captured["pending_turns"] == 2
    assert captured["turns_seen"] == 2
    assert captured["new_turns"] == 2
    assert captured["checkpoint_offset"] > 0
    assert captured["flushed_count"] == 0
    assert captured["native_written_count"] == 0
    assert captured["native_skipped_count"] == 0
    assert captured["native_record_ids"] == []
    assert summarized_batches == []

    transcript.write_text(transcript.read_text() + "\n".join([
        '{"type":"user","uuid":"u3","message":{"content":"q3"},"timestamp":"2026-01-01T00:02:00"}',
        '{"type":"assistant","uuid":"a3","parentUUID":"u3","message":{"content":"r3"},"timestamp":"2026-01-01T00:02:01"}',
        '{"type":"user","uuid":"u4","message":{"content":"q4"},"timestamp":"2026-01-01T00:03:00"}',
        '{"type":"assistant","uuid":"a4","parentUUID":"u4","message":{"content":"r4"},"timestamp":"2026-01-01T00:03:01"}',
    ]) + "\n")

    flushed = handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-1", "transcript_path": str(transcript), "event": "agent_end", "final": False, "idle": False, "summary_only": True, "message_count": 8})
    assert main_path.exists()
    assert flushed["result"] == "flushed"
    assert flushed["reason"] == "threshold"
    assert flushed["project"] == tmp_path.name
    assert flushed["pending_turns"] == 0
    assert flushed["flushed_count"] == 4
    assert flushed["native_written_count"] == 4
    assert flushed["native_skipped_count"] == 0
    assert len(flushed["native_record_ids"]) == 4
    assert all(record_id.startswith("session-capture:") for record_id in flushed["native_record_ids"])
    assert summarized_batches == [["u1", "u2", "u3", "u4"]]


def test_pi_adapter_session_capture_can_skip_markdown_writes(tmp_path, monkeypatch):
    from core.config import Config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True, session_capture_threshold_turns=1, session_capture_min_turns=1, session_capture_write_markdown=False)
    monkeypatch.setattr("core.config._config", cfg)
    monkeypatch.setattr("core.session_capture.get_config", lambda: cfg)
    reset_native_store(cfg.byomem / "native")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}\n'
        '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}\n'
    )

    handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-off", "transcript_path": str(transcript), "event": "agent_end", "final": True, "idle": False, "summary_only": True, "message_count": 2})
    assert not (cfg.byomem / tmp_path.name / "main.md").exists()
    assert not (tmp_path / ".claude" / "projects").exists()
    native_records = (cfg.byomem / "native" / "records.jsonl").read_text().strip().splitlines()
    assert len(native_records) == 1
    assert '"source":"pi:session_capture"' in native_records[0]
    assert '"scope_id":"project_' in native_records[0]

    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.models import MemoryRetrievalRequest

    project_id = resolve_project_id(str(tmp_path))
    retrieval = retrieve_memory(MemoryRetrievalRequest(query="Session turn", scope="project", filters={"project": project_id, "lifecycle": ["active", "archived", "superseded"]}))
    assert retrieval.results
    assert retrieval.results[0].record.source == "pi:session_capture"


def test_pi_adapter_session_capture_skips_missing_transcript(tmp_path, monkeypatch):
    from core.config import Config
    from core.pi_adapter import handle_pi_request

    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True)
    monkeypatch.setattr("core.config._config", cfg)

    response = handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-missing", "transcript_path": str(tmp_path / "missing.jsonl"), "message_count": 0})
    assert response["result"] == "skipped"
    assert response["reason"] == "missing transcript"


def test_pi_adapter_session_capture_is_idempotent_in_native_store(tmp_path, monkeypatch):
    from core.config import Config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True, session_capture_threshold_turns=1, session_capture_min_turns=1, session_capture_write_markdown=False)
    monkeypatch.setattr("core.config._config", cfg)
    monkeypatch.setattr("core.session_capture.get_config", lambda: cfg)
    reset_native_store(cfg.byomem / "native")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}\n'
        '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}\n'
    )

    request = {"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-dup", "transcript_path": str(transcript), "event": "agent_end", "final": True, "idle": False, "summary_only": True, "message_count": 2}
    first = handle_pi_request(request)
    second = handle_pi_request(request)
    native_lines = (cfg.byomem / "native" / "records.jsonl").read_text().strip().splitlines()
    assert first["result"] == "flushed"
    assert first["native_written_count"] == 1
    assert first["native_skipped_count"] == 0
    assert len(first["native_record_ids"]) == 1
    assert second["result"] == "captured"
    assert second["reason"] == "no-pending-turns"
    assert second["native_written_count"] == 0
    assert second["native_skipped_count"] == 0
    assert second["native_record_ids"] == []
    assert len(native_lines) == 1


def test_pi_adapter_session_capture_records_are_retrievable_via_native_path(tmp_path, monkeypatch):
    from core.config import Config
    from core.memory_identity import resolve_project_id
    from core.memory_retrieval import retrieve_memory
    from core.models import MemoryRetrievalRequest
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True, session_capture_threshold_turns=1, session_capture_min_turns=1, session_capture_write_markdown=False)
    monkeypatch.setattr("core.config._config", cfg)
    monkeypatch.setattr("core.session_capture.get_config", lambda: cfg)
    reset_native_store(cfg.byomem / "native")

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}\n'
        '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}\n'
    )

    response = handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-retrieve", "transcript_path": str(transcript), "event": "agent_end", "final": True, "idle": False, "summary_only": True, "message_count": 2})
    assert response["result"] == "flushed"
    assert response["native_written_count"] == 1
    assert len(response["native_record_ids"]) == 1
    assert response["native_record_ids"][0].startswith("session-capture:")

    project_id = resolve_project_id(str(tmp_path))
    retrieval = retrieve_memory(MemoryRetrievalRequest(query="Session turn", scope="project", filters={"project": project_id, "lifecycle": ["active", "archived", "superseded"]}))
    assert retrieval.results
    assert retrieval.results[0].record.source == "pi:session_capture"
    assert retrieval.results[0].record.content
    assert retrieval.results[0].record.id.startswith("session-capture:")


def test_pi_adapter_session_capture_logs_debug_details(tmp_path, monkeypatch):
    from core.config import Config, get_config
    from core.pi_adapter import handle_pi_request

    monkeypatch.setenv("BYOMEM_DEBUG", "1")
    cfg = Config(byomem=tmp_path / ".byomem", session_capture_enabled=True, session_capture_min_turns=1)
    monkeypatch.setattr("core.config._config", cfg)

    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text('{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}\n{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}\n')

    handle_pi_request({"action": "session_capture", "cwd": str(tmp_path), "session_id": "sess-log", "transcript_path": str(transcript), "event": "agent_end", "final": True, "idle": False, "message_count": 2, "summary_only": True})
    log_path = get_config().queue_path / "byomem_adapter_debug.jsonl"
    assert log_path.exists()
    log_text = log_path.read_text()
    assert 'python_adapter' in log_text
    assert 'session_capture' in log_text
    assert 'session_capture' in log_text
