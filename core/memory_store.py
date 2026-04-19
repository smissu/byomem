"""Persisted native BYOMem store for Pi-created records."""

from __future__ import annotations

from pathlib import Path

from core.config import get_config
from core.native_memory_index import index_native_record, native_index_path_for_store, remove_native_record
from core.models import MemoryRecord


class NativeMemoryStore:
    def __init__(self, root: Path | None = None):
        self.root = root or (get_config().byomem / "native")
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "records.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def has_record_id(self, record_id: str) -> bool:
        if not self.path.exists():
            return False
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and MemoryRecord.model_validate_json(line).id == record_id:
                    return True
        return False

    def write(self, record: MemoryRecord) -> MemoryRecord:
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(record.model_dump_json())
            fh.write("\n")
        index_native_record(record, native_index_path_for_store(self.root))
        return record

    def tombstone(self, record_id: str, *, scope: str | None = None, scope_id: str | None = None, updated_at: str | None = None) -> MemoryRecord | None:
        """Logically delete the latest live record version for record_id.

        This appends a tombstone record; it does not physically erase prior history.
        """
        records = self.load()
        for record in reversed(records):
            if record.id != record_id:
                continue
            if scope is not None and record.scope != scope:
                continue
            if scope_id is not None and record.scope_id != scope_id:
                continue
            if record.lifecycle == "deleted":
                return None
            tombstone = MemoryRecord(
                id=record.id,
                scope=record.scope,
                scope_id=record.scope_id,
                created_at=record.created_at,
                updated_at=updated_at or record.updated_at,
                source=record.source,
                content=record.content,
                lifecycle="deleted",
                expires_at=record.expires_at,
                tags=record.tags,
                source_kind=record.source_kind,
                source_ref=record.source_ref,
            )
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(tombstone.model_dump_json())
                fh.write("\n")
            remove_native_record(record_id, native_index_path_for_store(self.root))
            return tombstone
        return None

    def load(self) -> list[MemoryRecord]:
        if not self.path.exists():
            return []
        records: list[MemoryRecord] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    records.append(MemoryRecord.model_validate_json(line))
        return records

    def retrieve(self, *, scope: str, scope_id: str) -> list[MemoryRecord]:
        latest: dict[str, MemoryRecord] = {}
        for record in self.load():
            if record.scope == scope and record.scope_id == scope_id:
                latest[record.id] = record
        return [
            record
            for record in latest.values()
            if record.lifecycle not in {"deleted", "expired"}
        ]


_native_store: NativeMemoryStore | None = None


def get_native_store() -> NativeMemoryStore:
    global _native_store
    if _native_store is None:
        _native_store = NativeMemoryStore()
    return _native_store


def reset_native_store(root: Path | None = None) -> NativeMemoryStore:
    global _native_store
    _native_store = NativeMemoryStore(root)
    return _native_store
