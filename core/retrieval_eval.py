"""Offline retrieval evaluation helpers for BYOMem hybrid search."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.memory_retrieval import retrieve_memory
from core.models import MemoryRetrievalRequest


@dataclass(frozen=True)
class EvalCase:
    query: str
    scope: str
    filters: dict[str, Any]
    relevant_ids: list[str]


@dataclass(frozen=True)
class EvalResult:
    case: EvalCase
    rank: int | None
    top1_hit: bool
    top3_hit: bool
    mrr: float


DEFAULT_DATASET_PATH = Path("eval") / "retrieval_dataset.json"


def load_eval_dataset(path: str | Path = DEFAULT_DATASET_PATH) -> list[EvalCase]:
    payload = json.loads(Path(path).read_text())
    cases = []
    for item in payload.get("cases", []):
        cases.append(
            EvalCase(
                query=item["query"],
                scope=item["scope"],
                filters=item["filters"],
                relevant_ids=list(item.get("relevant_ids", [])),
            )
        )
    return cases


def evaluate_retrieval_cases(cases: list[EvalCase], weights: dict[str, float] | None = None) -> dict[str, Any]:
    from core import memory_retrieval as mr

    original = mr.RETRIEVAL_WEIGHTS if hasattr(mr, "RETRIEVAL_WEIGHTS") else None
    if weights is not None and hasattr(mr, "RETRIEVAL_WEIGHTS"):
        mr.RETRIEVAL_WEIGHTS = weights
    try:
        results: list[EvalResult] = []
        for case in cases:
            response = retrieve_memory(MemoryRetrievalRequest(query=case.query, scope=case.scope, filters=case.filters))
            rank = None
            for idx, item in enumerate(response.results, start=1):
                if item.record.id in case.relevant_ids:
                    rank = idx
                    break
            top1 = rank == 1
            top3 = rank is not None and rank <= 3
            mrr = 1.0 / rank if rank else 0.0
            results.append(EvalResult(case=case, rank=rank, top1_hit=top1, top3_hit=top3, mrr=mrr))
        count = len(results) or 1
        return {
            "top1": sum(r.top1_hit for r in results) / count,
            "top3": sum(r.top3_hit for r in results) / count,
            "mrr": sum(r.mrr for r in results) / count,
            "results": [
                {
                    "query": r.case.query,
                    "rank": r.rank,
                    "top1_hit": r.top1_hit,
                    "top3_hit": r.top3_hit,
                    "mrr": r.mrr,
                    "relevant_ids": r.case.relevant_ids,
                }
                for r in results
            ],
        }
    finally:
        if original is not None:
            mr.RETRIEVAL_WEIGHTS = original


def sweep_weight_settings(cases: list[EvalCase], candidates: list[dict[str, float]]) -> list[dict[str, Any]]:
    runs = []
    for weights in candidates:
        metrics = evaluate_retrieval_cases(cases, weights=weights)
        runs.append({"weights": weights, **metrics})
    return runs
