"""Minimal stateless retrieval seam for tranche-1 contract bridging."""

from __future__ import annotations

from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse


_ALLOWED_LIFECYCLES = {"active", "archived", "superseded"}
_ALLOWED_SCOPES = {"project", "dir", "user", "agent"}


def fetch_candidates(request: MemoryRetrievalRequest) -> list[MemoryRecord]:
    """Backend seam for deterministic candidate injection in tests."""

    return []


def _filtered_results(candidates: list[MemoryRecord], request: MemoryRetrievalRequest) -> list[MemoryRecord]:
    allowed_lifecycles = request.filters.get("lifecycle")
    if isinstance(allowed_lifecycles, list):
        allowed = set(allowed_lifecycles)
    else:
        allowed = {"active", "archived", "superseded"}

    allowed &= _ALLOWED_LIFECYCLES
    return [
        candidate
        for candidate in candidates
        if candidate.scope == request.scope
        and candidate.scope in _ALLOWED_SCOPES
        and candidate.lifecycle in allowed
        and candidate.lifecycle != "deleted"
        and candidate.lifecycle != "expired"
    ]


def retrieve_memory(request: MemoryRetrievalRequest) -> MemoryRetrievalResponse:
    """Return a deterministic tranche-1 retrieval response for a valid request."""

    candidates = fetch_candidates(request)
    return MemoryRetrievalResponse(results=_filtered_results(candidates, request), request=request)
