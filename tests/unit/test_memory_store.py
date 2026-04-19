import pytest

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


def test_native_store_tombstone_overrides_latest_record_and_retrieval(tmp_path):
    from core.memory_store import NativeMemoryStore

    store = NativeMemoryStore(tmp_path / ".byomem" / "native")
    active = MemoryRecord(
        id="mem-3",
        scope="project",
        scope_id="proj-a",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:store",
        content="project memory",
        source_kind="pi_native_store",
    )
    store.write(active)

    tombstone = store.tombstone("mem-3", scope="project", scope_id="proj-a", updated_at="2026-01-02T00:00:00Z")
    assert tombstone is not None
    assert tombstone.lifecycle == "deleted"
    assert store.retrieve(scope="project", scope_id="proj-a") == []
    assert store.load()[-1].lifecycle == "deleted"
    assert store.tombstone("mem-3", scope="project", scope_id="proj-a", updated_at="2026-01-03T00:00:00Z") is None


def test_native_store_prune_then_store_replacement_returns_replacement_only(tmp_path, mocker):
    from core.memory_store import reset_native_store
    from core.models import MemoryRecord
    from core.native_memory_index import native_index_path_for_store, search_native_records

    store = reset_native_store(tmp_path / ".byomem" / "native")
    db_path = native_index_path_for_store(store.root)

    mocker.patch(
        "core.native_memory_index._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.1, 0.2, 0.3], True)] * len(texts),
    )
    mocker.patch("core.native_memory_index._get_embedding", return_value=None)

    original = MemoryRecord(
        id="mem-4",
        scope="project",
        scope_id="proj-a",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:store",
        content="original memory about database cache",
        source_kind="pi_native_store",
    )
    store.write(original)
    store.tombstone("mem-4", scope="project", scope_id="proj-a", updated_at="2026-01-02T00:00:00Z")

    replacement = MemoryRecord(
        id="mem-5",
        scope="project",
        scope_id="proj-a",
        created_at="2026-01-03T00:00:00Z",
        updated_at="2026-01-03T00:00:00Z",
        source="pi:replace",
        content="corrected memory about search indexing",
        source_kind="pi_native_store",
    )
    store.write(replacement)

    results = search_native_records("project", "proj-a", "search indexing", db_path=db_path)
    contents = [candidate["record"].content for candidate in results]
    ids = [candidate["record"].id for candidate in results]

    assert "corrected memory about search indexing" in contents
    assert "original memory about database cache" not in contents
    assert "mem-5" in ids
