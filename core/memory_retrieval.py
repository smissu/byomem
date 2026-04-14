"""Minimal stateless retrieval seam for tranche-1 contract bridging."""

from __future__ import annotations

from core.models import MemoryRetrievalRequest, MemoryRetrievalResponse


def retrieve_memory(request: MemoryRetrievalRequest) -> MemoryRetrievalResponse:
    """Return an empty tranche-1 retrieval response for a valid request."""

    return MemoryRetrievalResponse(results=[], request=request)
