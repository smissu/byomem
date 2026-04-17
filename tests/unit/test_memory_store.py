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
