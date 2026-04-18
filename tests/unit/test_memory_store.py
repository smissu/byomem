from core.models import MemoryRecord


def test_persisted_native_store_survives_reload(tmp_path, monkeypatch):
    from core.memory_store import NativeMemoryStore

    store = NativeMemoryStore(tmp_path / ".byomem" / "native")
    record = MemoryRecord(
        id="mem-1",
        scope="project",
        scope_id="proj-a",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:store",
        content="project memory",
        source_kind="pi_native_store",
    )
    store.write(record)

    reloaded = NativeMemoryStore(tmp_path / ".byomem" / "native")
    assert reloaded.load() == [record]
    assert reloaded.retrieve(scope="project", scope_id="proj-a") == [record]


def test_native_store_write_preserves_explicit_source_metadata(tmp_path):
    from core.memory_store import NativeMemoryStore

    store = NativeMemoryStore(tmp_path / ".byomem" / "native")
    record = MemoryRecord(
        id="mem-2",
        scope="project",
        scope_id="proj-a",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:session_capture",
        source_kind="session_capture_summary",
        source_ref="session:sess-1:turn:t-1",
        content="captured native memory",
    )

    store.write(record)
    loaded = store.load()[0]

    assert loaded.source == "pi:session_capture"
    assert loaded.source_kind == "session_capture_summary"
    assert loaded.source_ref == "session:sess-1:turn:t-1"
