"""
DiversitySelector: ensures the final chunk set spans multiple files.

After re-ranking, the top-N chunks might all come from the same heavily-chunked
file. DiversitySelector enforces a maximum-per-file cap so the context window
reflects a breadth of relevant code rather than one file in depth.

Selection is greedy in score order: chunks are added until we reach the
target count or exhaust the input.
"""
from __future__ import annotations

from collections import defaultdict
import structlog

from src.core.models import RetrievedChunk

logger = structlog.get_logger()


class DiversitySelector:
    """Selects up to final_k chunks with at most max_per_file per file."""

    def __init__(self, max_per_file: int = 3, final_k: int = 8) -> None:
        self._max_per_file = max_per_file
        self._final_k = final_k

    def select(self, chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
        """Greedy selection from highest-score chunks, respecting per-file cap."""
        per_file: dict[str, int] = defaultdict(int)
        selected: list[RetrievedChunk] = []

        for chunk in chunks:  # already sorted by score desc from Reranker
            if len(selected) >= self._final_k:
                break
            if per_file[chunk.file_path] < self._max_per_file:
                selected.append(chunk)
                per_file[chunk.file_path] += 1

        logger.debug(
            "diversity_selector",
            input_count=len(chunks),
            output_count=len(selected),
            files_represented=len(per_file),
            max_per_file=self._max_per_file,
        )
        return selected
