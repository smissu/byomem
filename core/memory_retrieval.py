"""Minimal stateless retrieval seam for native BYOMem records."""

from __future__ import annotations

from core.memory_store import get_native_store
from core.native_memory_index import search_native_records, native_index_path_for_store
from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse, MemoryRetrievalResult


_ALLOWED_LIFECYCLES = {"active", "archived", "superseded"}
_ALLOWED_SCOPES = {"project", "user"}
RETRIEVAL_WEIGHTS = {"semantic": 0.65, "lexical": 0.35}


def _candidate_record(candidate: dict[str, object] | MemoryRecord) -> MemoryRecord:
    if isinstance(candidate, MemoryRecord):
        return candidate
    return candidate["record"]


def _candidate_metadata(candidate: dict[str, object] | MemoryRecord) -> tuple[str, object, object, object, object, object]:
    if isinstance(candidate, dict):
        return (
            str(candidate.get("candidate_source", "fts")),
            candidate.get("lexical_score"),
            candidate.get("semantic_score"),
            candidate.get("semantic_available", False),
            candidate.get("semantic_rerank_applied", False),
            candidate.get("lexical_rank"),
        )
    return "fts", None, None, False, False, None


def _build_reason(candidate_source: str, semantic_available: object, semantic_rerank_applied: object) -> str:
    if candidate_source == "semantic":
        return "semantic-only recall beyond FTS gate"
    if candidate_source == "hybrid":
        return "hybrid lexical + semantic recall"
    if semantic_available:
        return "fts lexical match with semantic rerank" if semantic_rerank_applied else "fts lexical match"
    return "fts lexical match (semantic unavailable)"


def _build_provenance(record: MemoryRecord, candidate_source: str, lexical_score: object, semantic_score: object, semantic_available: object, semantic_rerank_applied: object, lexical_rank: object) -> str:
    provenance_parts = [
        f"candidate_source={candidate_source}",
        f"lexical_rank={lexical_rank}",
        f"lexical_score={lexical_score:.4f}" if isinstance(lexical_score, (int, float)) else "lexical_score=none",
        f"semantic_available={'true' if semantic_available else 'false'}",
        f"semantic_rerank={'true' if semantic_rerank_applied else 'false'}",
    ]
    if isinstance(semantic_score, (int, float)):
        provenance_parts.append(f"semantic_score={semantic_score:.4f}")
    provenance_parts.append(f"record={record.source}#{record.id}")
    return "; ".join(provenance_parts)


def _build_explainability(candidate: dict[str, object] | MemoryRecord) -> tuple[str, str]:
    record = _candidate_record(candidate)
    candidate_source, lexical_score, semantic_score, semantic_available, semantic_rerank_applied, lexical_rank = _candidate_metadata(candidate)
    return _build_reason(candidate_source, semantic_available, semantic_rerank_applied), _build_provenance(record, candidate_source, lexical_score, semantic_score, semantic_available, semantic_rerank_applied, lexical_rank)


def _looks_like_identity_lookup(query: str) -> bool:
    query = query.strip()
    return " " not in query and len(query) >= 8


def _requested_lifecycles(request: MemoryRetrievalRequest) -> list[str] | None:
    allowed_lifecycles = request.filters.get("lifecycle")
    return allowed_lifecycles if isinstance(allowed_lifecycles, list) else None


def _scope_id_for_request(request: MemoryRetrievalRequest) -> str | None:
    scope_id = request.filters.get(request.scope)
    return scope_id if isinstance(scope_id, str) and scope_id else None


def _fetch_native_candidates(store, request: MemoryRetrievalRequest, scope_id: str, lifecycle: list[str] | None) -> list[dict[str, object]]:
    return search_native_records(
        request.scope,
        scope_id,
        request.query,
        lifecycle=lifecycle,
        db_path=native_index_path_for_store(store.root),
    )


def _hydrate_identity_candidates(candidates: list[dict[str, object] | MemoryRecord], store_records: dict[str, MemoryRecord]) -> list[dict[str, object] | MemoryRecord]:
    hydrated: list[dict[str, object] | MemoryRecord] = []
    for candidate in candidates:
        if isinstance(candidate, MemoryRecord):
            hydrated.append(store_records.get(candidate.id, candidate))
            continue
        record = candidate.get("record")
        if isinstance(record, MemoryRecord) and record.id in store_records:
            hydrated.append({**candidate, "record": store_records[record.id]})
        else:
            hydrated.append(candidate)
    return hydrated


def _store_fallback_candidates(store, request: MemoryRetrievalRequest, scope_id: str, lifecycle: list[str] | None) -> list[dict[str, object]]:
    allowed = _ALLOWED_LIFECYCLES if lifecycle is None else set(lifecycle) & _ALLOWED_LIFECYCLES
    records = [
        record
        for record in store.retrieve(scope=request.scope, scope_id=scope_id)
        if record.lifecycle in allowed and request.query.lower() in record.content.lower()
    ]
    return [
        {"record": record, "candidate_source": "store", "lexical_rank": None, "lexical_score": None, "semantic_available": False, "semantic_rerank_applied": False, "semantic_score": None}
        for record in records
    ]


def fetch_candidates(request: MemoryRetrievalRequest) -> list[dict[str, object]]:
    scope_id = _scope_id_for_request(request)
    if scope_id is None:
        return []
    lifecycle = _requested_lifecycles(request)

    store = get_native_store()
    candidates = _fetch_native_candidates(store, request, scope_id, lifecycle)
    if candidates:
        if _looks_like_identity_lookup(request.query):
            store_records = {record.id: record for record in store.retrieve(scope=request.scope, scope_id=scope_id)}
            return _hydrate_identity_candidates(candidates, store_records)
        return candidates

    return _store_fallback_candidates(store, request, scope_id, lifecycle)


def _final_score(candidate: dict[str, object] | MemoryRecord) -> float:
    lexical_score = candidate.get("lexical_score") if isinstance(candidate, dict) else None
    semantic_score = candidate.get("semantic_score") if isinstance(candidate, dict) else None
    final = 0.0
    if isinstance(candidate, dict) and candidate.get("candidate_source") == "fts" and isinstance(lexical_score, (int, float)):
        return float(lexical_score)
    weights = RETRIEVAL_WEIGHTS
    if isinstance(semantic_score, (int, float)):
        final += float(semantic_score) * float(weights.get("semantic", 0.65))
    if isinstance(lexical_score, (int, float)):
        final += float(lexical_score) * float(weights.get("lexical", 0.35))
    return final


def _allowed_lifecycles(request: MemoryRetrievalRequest) -> set[str]:
    requested = request.filters.get("lifecycle")
    allowed = set(requested) if isinstance(requested, list) else _ALLOWED_LIFECYCLES
    return allowed & _ALLOWED_LIFECYCLES


def _passes_scope_and_lifecycle(record: MemoryRecord, request: MemoryRetrievalRequest, allowed: set[str]) -> bool:
    return record.scope == request.scope and record.scope in _ALLOWED_SCOPES and record.lifecycle in allowed


def _rank_results(candidates: list[dict[str, object] | MemoryRecord], request: MemoryRetrievalRequest) -> list[tuple[float, int, MemoryRetrievalResult]]:
    allowed = _allowed_lifecycles(request)
    ranked: list[tuple[float, int, MemoryRetrievalResult]] = []
    for index, candidate in enumerate(candidates):
        record = _candidate_record(candidate)
        if not _passes_scope_and_lifecycle(record, request, allowed):
            continue
        reason, provenance = _build_explainability(candidate)
        ranked.append((_final_score(candidate), index, MemoryRetrievalResult(record=record, reason=reason, provenance=provenance)))
    return ranked


def _filtered_results(candidates: list[dict[str, object] | MemoryRecord], request: MemoryRetrievalRequest) -> list[MemoryRetrievalResult]:
    ranked = _rank_results(candidates, request)
    ranked.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    return [result for _score, _index, result in ranked]


def retrieve_memory(request: MemoryRetrievalRequest) -> MemoryRetrievalResponse:
    candidates = fetch_candidates(request)
    return MemoryRetrievalResponse(results=_filtered_results(candidates, request), request=request)
