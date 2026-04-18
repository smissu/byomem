from __future__ import annotations

import pytest

from tests.unit.parity_utils import load_parity_fixture, normalize_search_response, normalize_session_capture_response, normalize_store_response


def load_fixture(name: str):
    return load_parity_fixture(name)


pytestmark = pytest.mark.parity


def test_parity_fixtures_exist_and_are_normalized():
    store_request = load_fixture("store_project_request.json")
    store_response = load_fixture("store_project_response.json")
    search_request = load_fixture("pi_search_request.json")
    session_capture_request = load_fixture("session_capture_request.json")

    assert store_request["action"] == "store"
    assert store_request["scope"] == "project"
    assert store_request["summary"] is None
    assert store_response["ok"] is True
    assert store_response["scope"] == "project"
    assert search_request["query"] == "stop price"
    assert session_capture_request["action"] == "session_capture"
    assert session_capture_request["summary_only"] is True


def test_parity_fixture_shapes_align_with_current_python_contracts():
    from core.models import MemoryStoreRequest, SessionCaptureRequest

    store_request = MemoryStoreRequest(**load_fixture("store_project_request.json"))
    session_request = SessionCaptureRequest(**load_fixture("session_capture_request.json"))

    assert store_request.scope == "project"
    assert store_request.text.startswith("Remember to keep stop price")
    assert session_request.session_id == "sess-001"
    assert session_request.final is False


def test_python_backed_store_parity_replay(tmp_path, monkeypatch):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    reset_native_store(cfg.byomem / "native")

    request = load_fixture("store_project_request.json")
    request["cwd"] = str(tmp_path / "repo-a")
    request["cwd"] and (tmp_path / "repo-a").mkdir()

    actual = handle_pi_request(request)
    expected = load_fixture("store_project_response.json")
    expected["path"] = str(cfg.byomem / "native" / "records.jsonl")
    expected["scope_id"] = actual["scope_id"]

    assert normalize_store_response(actual) == normalize_store_response(expected)


def test_python_backed_search_parity_replay(tmp_path):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    store_request = load_fixture("store_project_request.json")
    store_request["cwd"] = str(cwd)
    handle_pi_request(store_request)

    # Seed one distractor record to prove the replay hits the query term.
    handle_pi_request({**store_request, "text": "Unrelated note about something else."})

    actual = handle_pi_request(load_fixture("pi_search_request.json") | {"cwd": str(cwd)})
    expected = load_fixture("pi_search_response.json")

    assert normalize_search_response(actual) == normalize_search_response(expected)


def test_python_backed_session_capture_checkpoint_parity_replay(tmp_path):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    cfg.session_capture_enabled = True
    cfg.session_capture_min_turns = 2
    cfg.session_capture_threshold_turns = 4
    cfg.session_capture_large_turn_chars = 9999
    cfg.session_capture_write_markdown = False
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    transcript = tmp_path / "transcripts" / "sess-001.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        '\n'.join([
            '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}',
            '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}',
        ]) + '\n'
    )

    request = load_fixture("session_capture_request.json")
    request["cwd"] = str(cwd)
    request["transcript_path"] = str(transcript)
    request["message_count"] = 2

    actual = handle_pi_request(request)
    expected = load_fixture("session_capture_checkpoint_response.json")

    assert normalize_session_capture_response(actual) == normalize_session_capture_response(expected)


def test_python_backed_session_capture_flush_parity_replay(tmp_path):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.pi_adapter import handle_pi_request

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    cfg.session_capture_enabled = True
    cfg.session_capture_min_turns = 1
    cfg.session_capture_threshold_turns = 4
    cfg.session_capture_large_turn_chars = 9999
    cfg.session_capture_write_markdown = False
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    transcript = tmp_path / "transcripts" / "sess-002.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        '\n'.join([
            '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}',
            '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}',
            '{"type":"user","uuid":"u2","message":{"content":"q2"},"timestamp":"2026-01-01T00:01:00"}',
            '{"type":"assistant","uuid":"a2","parentUUID":"u2","message":{"content":"r2"},"timestamp":"2026-01-01T00:01:01"}',
        ]) + '\n'
    )

    request = load_fixture("session_capture_flush_request.json")
    request["cwd"] = str(cwd)
    request["transcript_path"] = str(transcript)
    request["message_count"] = 4

    actual = handle_pi_request(request)
    expected = load_fixture("session_capture_flush_response.json")

    assert normalize_session_capture_response(actual) == normalize_session_capture_response(expected)


def test_python_backed_session_capture_flush_records_are_retrievable(tmp_path):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.memory_identity import resolve_project_id
    from core.models import MemoryRetrievalRequest
    from core.pi_adapter import handle_pi_request
    from core.memory_retrieval import retrieve_memory

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    cfg.session_capture_enabled = True
    cfg.session_capture_min_turns = 1
    cfg.session_capture_threshold_turns = 4
    cfg.session_capture_large_turn_chars = 9999
    cfg.session_capture_write_markdown = False
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    transcript = tmp_path / "transcripts" / "sess-002.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        '\n'.join([
            '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}',
            '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}',
            '{"type":"user","uuid":"u2","message":{"content":"q2"},"timestamp":"2026-01-01T00:01:00"}',
            '{"type":"assistant","uuid":"a2","parentUUID":"u2","message":{"content":"r2"},"timestamp":"2026-01-01T00:01:01"}',
        ]) + '\n'
    )

    request = load_fixture("session_capture_flush_request.json")
    request["cwd"] = str(cwd)
    request["transcript_path"] = str(transcript)
    request["message_count"] = 4
    handle_pi_request(request)

    retrieval_request = MemoryRetrievalRequest(
        query="q1",
        scope="project",
        filters={"project": resolve_project_id(str(cwd)), "lifecycle": ["active", "archived", "superseded"]},
    )
    results = retrieve_memory(retrieval_request).results

    assert results
    assert any(result.record.source == "pi:session_capture" for result in results)
    assert any((result.record.source_ref and "q1" in result.record.source_ref) or "q1" in result.record.content for result in results)


def test_python_backed_session_capture_flush_idempotent_replay(tmp_path):
    from core.config import get_config
    from core.memory_store import reset_native_store
    from core.memory_identity import resolve_project_id
    from core.models import MemoryRetrievalRequest
    from core.pi_adapter import handle_pi_request
    from core.memory_retrieval import retrieve_memory

    cfg = get_config()
    cfg.byomem = tmp_path / ".byomem"
    cfg.byomem.mkdir(parents=True, exist_ok=True)
    cfg.session_capture_enabled = True
    cfg.session_capture_min_turns = 1
    cfg.session_capture_threshold_turns = 4
    cfg.session_capture_large_turn_chars = 9999
    cfg.session_capture_write_markdown = False
    reset_native_store(cfg.byomem / "native")

    cwd = tmp_path / "repo-a"
    cwd.mkdir()
    transcript = tmp_path / "transcripts" / "sess-002.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        '\n'.join([
            '{"type":"user","uuid":"u1","message":{"content":"q1"},"timestamp":"2026-01-01T00:00:00"}',
            '{"type":"assistant","uuid":"a1","parentUUID":"u1","message":{"content":"r1"},"timestamp":"2026-01-01T00:00:01"}',
            '{"type":"user","uuid":"u2","message":{"content":"q2"},"timestamp":"2026-01-01T00:01:00"}',
            '{"type":"assistant","uuid":"a2","parentUUID":"u2","message":{"content":"r2"},"timestamp":"2026-01-01T00:01:01"}',
        ]) + '\n'
    )

    request = load_fixture("session_capture_flush_request.json")
    request["cwd"] = str(cwd)
    request["transcript_path"] = str(transcript)
    request["message_count"] = 4

    first = handle_pi_request(request)
    first_results = retrieve_memory(MemoryRetrievalRequest(query="q1", scope="project", filters={"project": resolve_project_id(str(cwd)), "lifecycle": ["active", "archived", "superseded"]})).results
    first_count = len(first_results)

    second = handle_pi_request(request)
    second_results = retrieve_memory(MemoryRetrievalRequest(query="q1", scope="project", filters={"project": resolve_project_id(str(cwd)), "lifecycle": ["active", "archived", "superseded"]})).results

    assert first["result"] == "flushed"
    assert second["result"] in {"captured", "flushed"}
    assert len(second_results) == first_count
    assert any(result.record.source == "pi:session_capture" for result in second_results)
    assert any((result.record.source_ref and "q1" in result.record.source_ref) or "q1" in result.record.content for result in second_results)
