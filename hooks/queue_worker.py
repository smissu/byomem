#!/usr/bin/env python3
"""Entry point for the background queue worker process."""

import logging
import sys
from pathlib import Path

# Allow imports from the parent directory (byomem root)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    stream=sys.stderr,
)

from core.worker import run_worker  # noqa: E402

if __name__ == "__main__":
    run_worker()
