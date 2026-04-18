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


def _build_explainability(candidate: dict[str, object] | MemoryRecord) -> tuple[str, str]:
    record = _candidate_record(candidate)
    candidate_source = candidate.get("candidate_source", "fts") if isinstance(candidate, dict) else "fts"
    lexical_score = candidate.get("lexical_score") if isinstance(candidate, dict) else None
    semantic_score = candidate.get("semantic_score") if isinstance(candidate, dict) else None
    semantic_available = candidate.get("semantic_available") if isinstance(candidate, dict) else False
    semantic_rerank_applied = candidate.get("semantic_rerank_applied") if isinstance(candidate, dict) else False
    lexical_rank = candidate.get("lexical_rank") if isinstance(candidate, dict) else None
    if candidate_source == "semantic":
        reason = "semantic-only recall beyond FTS gate"
    elif candidate_source == "hybrid":
        reason = "hybrid lexical + semantic recall"
    elif semantic_available:
        reason = "fts lexical match with semantic rerank" if semantic_rerank_applied else "fts lexical match"
    else:
        reason = "fts lexical match (semantic unavailable)"
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
    return reason, "; ".join(provenance_parts)


def _looks_like_identity_lookup(query: str) -> bool:
    query = query.strip()
    return " " not in query and len(query) >= 8


def fetch_candidates(request: MemoryRetrievalRequest) -> list[dict[str, object]]:
    scope_id = request.filters.get(request.scope)
    if not isinstance(scope_id, str) or not scope_id:
        return []
    allowed_lifecycles = request.filters.get("lifecycle")
    lifecycle = allowed_lifecycles if isinstance(allowed_lifecycles, list) else None

    store = get_native_store()
    candidates = search_native_records(
        request.scope,
        scope_id,
        request.query,
        lifecycle=lifecycle,
        db_path=native_index_path_for_store(store.root),
    )
    if candidates:
        if _looks_like_identity_lookup(request.query):
            store_records = {record.id: record for record in store.retrieve(scope=request.scope, scope_id=scope_id)}
            hydrated: list[dict[str, object]] = []
            for candidate in candidates:
                record = candidate.get("record")
                if isinstance(record, MemoryRecord) and record.id in store_records:
                    hydrated.append({**candidate, "record": store_records[record.id]})
                else:
                    hydrated.append(candidate)
            return hydrated
        return candidates

    store_records = [record for record in store.retrieve(scope=request.scope, scope_id=scope_id) if record.lifecycle in (_ALLOWED_LIFECYCLES if lifecycle is None else set(lifecycle) & _ALLOWED_LIFECYCLES) and request.query.lower() in record.content.lower()]
    return [{"record": record, "candidate_source": "store", "lexical_rank": None, "lexical_score": None, "semantic_available": False, "semantic_rerank_applied": False, "semantic_score": None} for record in store_records]


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


def _filtered_results(candidates: list[dict[str, object] | MemoryRecord], request: MemoryRetrievalRequest) -> list[MemoryRetrievalResult]:
    allowed_lifecycles = request.filters.get("lifecycle")
    allowed = set(allowed_lifecycles) if isinstance(allowed_lifecycles, list) else _ALLOWED_LIFECYCLES
    allowed &= _ALLOWED_LIFECYCLES
    ranked: list[tuple[float, int, MemoryRetrievalResult]] = []
    for index, candidate in enumerate(candidates):
        record = _candidate_record(candidate)
        if record.scope != request.scope or record.scope not in _ALLOWED_SCOPES or record.lifecycle not in allowed:
            continue
        reason, provenance = _build_explainability(candidate)
        ranked.append((_final_score(candidate), index, MemoryRetrievalResult(record=record, reason=reason, provenance=provenance)))
    ranked.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    return [result for _score, _index, result in ranked]


def retrieve_memory(request: MemoryRetrievalRequest) -> MemoryRetrievalResponse:
    candidates = fetch_candidates(request)
    return MemoryRetrievalResponse(results=_filtered_results(candidates, request), request=request)
