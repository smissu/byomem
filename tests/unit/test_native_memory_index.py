import struct

from core.models import MemoryRecord


def _embedding_blob(values):
    return struct.pack(f"{len(values)}f", *values)


def test_native_index_persists_embedding_sidecar_and_scope_metadata(tmp_path, mocker):
    from core.native_memory_index import get_native_index_db, index_native_record, native_index_path_for_store

    db_path = native_index_path_for_store(tmp_path / ".byomem" / "native")
    mocker.patch(
        "core.native_memory_index._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([0.1, 0.2, 0.3], True)] * len(texts),
    )

    record = MemoryRecord(
        id="rec-1",
        scope="project",
        scope_id="project-1",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
        source="pi:store",
        content="semantic project note",
        source_kind="pi_native_store",
    )
    index_native_record(record, db_path)

    db = get_native_index_db(db_path)
    try:
        row = db.execute(
            "SELECT record_id, scope, scope_id, text_hash, length(embedding) FROM native_record_embeddings WHERE record_id=?",
            ("rec-1",),
        ).fetchone()
    finally:
        db.close()

    assert row[:4] == ("rec-1", "project", "project-1", row[3])
    assert row[4] > 0


def test_native_semantic_rerank_reorders_fts_candidates(tmp_path, mocker):
    from core.native_memory_index import native_index_path_for_store, search_native_records
    from core.memory_store import reset_native_store

    store = reset_native_store(tmp_path / ".byomem" / "native")
    db_path = native_index_path_for_store(store.root)
    embed_map = {
        "database tuning notes": [1.0, 0.0],
        "cache invalidation guide": [0.0, 1.0],
        "query optimization": [0.9, 0.1],
    }

    def fake_batch(db, texts, hashes, **kw):
        return [(embed_map[text], True) for text in texts]

    mocker.patch("core.native_memory_index._get_embeddings_batch", side_effect=fake_batch)
    mocker.patch("core.native_memory_index._get_embedding", return_value=[0.0, 1.0])

    for rid, content in [
        ("r1", "database tuning notes"),
        ("r2", "cache invalidation guide"),
        ("r3", "query optimization"),
    ]:
        store.write(
            MemoryRecord(
                id=rid,
                scope="project",
                scope_id="project-1",
                created_at="2026-01-01T00:00:00Z",
                updated_at="2026-01-01T00:00:00Z",
                source="pi:store",
                content=content,
                source_kind="pi_native_store",
            )
        )

    results = search_native_records("project", "project-1", "database cache", db_path=db_path)
    assert [candidate["record"].content for candidate in results[:2]] == ["database tuning notes", "cache invalidation guide"]


def test_native_semantic_search_falls_back_to_fts_when_embeddings_unavailable(tmp_path, mocker):
    from core.native_memory_index import native_index_path_for_store, search_native_records
    from core.memory_store import reset_native_store

    store = reset_native_store(tmp_path / ".byomem" / "native")
    db_path = native_index_path_for_store(store.root)
    mocker.patch(
        "core.native_memory_index._get_embeddings_batch",
        side_effect=lambda db, texts, hashes, **kw: [([1.0, 0.0], True)] * len(texts),
    )
    mocker.patch("core.native_memory_index._get_embedding", return_value=None)

    store.write(
        MemoryRecord(
            id="r1",
            scope="project",
            scope_id="project-1",
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
            source="pi:store",
            content="alpha beta gamma",
            source_kind="pi_native_store",
        )
    )
    store.write(
        MemoryRecord(
            id="r2",
            scope="project",
            scope_id="project-1",
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
            source="pi:store",
            content="beta only",
            source_kind="pi_native_store",
        )
    )

    results = search_native_records("project", "project-1", "beta gamma", db_path=db_path)
    assert [candidate["record"].content for candidate in results] == ["alpha beta gamma", "beta only"]
