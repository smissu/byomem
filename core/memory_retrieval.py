"""Minimal stateless retrieval seam for tranche-1 contract bridging.

Tranche 1 uses strict exact request-scope matching and does not yet implement
cross-scope precedence or ranking.
"""

from __future__ import annotations

from core.models import MemoryRecord, MemoryRetrievalRequest, MemoryRetrievalResponse


_ALLOWED_LIFECYCLES = {"active", "archived", "superseded"}
_ALLOWED_SCOPES = {"project", "dir", "user", "agent"}


def fetch_candidates(request: MemoryRetrievalRequest) -> list[MemoryRecord]:
    """Backend seam for deterministic candidate injection in tests."""

    return []


def _filtered_results(candidates: list[MemoryRecord], request: MemoryRetrievalRequest) -> list[MemoryRecord]:
    allowed_lifecycles = request.filters.get("lifecycle")
    allowed = set(allowed_lifecycles) if isinstance(allowed_lifecycles, list) else _ALLOWED_LIFECYCLES
    allowed &= _ALLOWED_LIFECYCLES

    # Tranche 1 is exact-match only: keep only candidates in the explicit request scope.
    return [
        candidate
        for candidate in candidates
        if candidate.scope == request.scope
        and candidate.scope in _ALLOWED_SCOPES
        and candidate.lifecycle in allowed
        and candidate.lifecycle not in {"deleted", "expired"}
    ]


def retrieve_memory(request: MemoryRetrievalRequest) -> MemoryRetrievalResponse:
    """Return a deterministic tranche-1 retrieval response for a valid request."""

    candidates = fetch_candidates(request)
    return MemoryRetrievalResponse(results=_filtered_results(candidates, request), request=request)
