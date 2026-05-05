#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import numpy as np
from model2vec import StaticModel


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description='Line-delimited JSON embedding server for Model2Vec.')
    parser.add_argument('--model', required=True)
    args = parser.parse_args()

    model = StaticModel.from_pretrained(args.model)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request.get('id')
            texts = request.get('texts')
            if not isinstance(request_id, str) or not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
                raise ValueError('Request must include string id and texts array')
            embeddings = model.encode(texts)
            payload = np.asarray(embeddings, dtype=np.float32).tolist()
            _emit({'id': request_id, 'embeddings': payload})
        except Exception as exc:  # pragma: no cover - surfaced to caller
            try:
                request_id = request.get('id') if 'request' in locals() and isinstance(request, dict) else None
            except Exception:
                request_id = None
            _emit({'id': request_id, 'error': f'{type(exc).__name__}: {exc}'})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
