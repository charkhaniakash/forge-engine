"""
MetadataFilter: removes noisy chunks from the candidate set before re-ranking.

Runs after VectorCandidateGenerator. Currently filters:
  - Test files (configurable patterns)
  - Chunks without embeddings (should be excluded by SQL but belt-and-suspenders)

Designed to be cheap — no LLM calls, pure Python string matching.
"""
from __future__ import annotations

import re
import structlog

from src.core.models import RetrievedChunk

logger = structlog.get_logger()

# File-path patterns that indicate test files.
# A chunk is excluded if its file_path matches any of these patterns.
_TEST_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(^|/)tests?/", re.IGNORECASE),
    re.compile(r"(^|/)__tests__/", re.IGNORECASE),
    re.compile(r"(^|/)spec/", re.IGNORECASE),
    re.compile(r"_test\.(py|go|ts|js|rb|java|rs)$", re.IGNORECASE),
    re.compile(r"\.spec\.(ts|js|tsx|jsx)$", re.IGNORECASE),
    re.compile(r"_spec\.(rb|go)$", re.IGNORECASE),
]

# File-path patterns for generated / vendored files that add noise.
_GENERATED_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(^|/)vendor/"),
    re.compile(r"(^|/)node_modules/"),
    re.compile(r"(^|/)\.gen/"),
    re.compile(r"\.pb\.go$"),
    re.compile(r"_generated\.(go|py|ts)$"),
]


class MetadataFilter:
    """Filters the candidate set based on file-path metadata.

    filter_tests and filter_generated are True by default.
    Pass filter_tests=False to include test files (useful for planning,
    bug investigation, and execution where test context is essential).
    """

    def __init__(
        self,
        filter_tests: bool = True,
        filter_generated: bool = True,
    ) -> None:
        self._filter_tests = filter_tests
        self._filter_generated = filter_generated

    def filter(self, chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
        """Return chunks that pass all active filters."""
        before = len(chunks)
        result = [c for c in chunks if self._keep(c)]
        after = len(result)

        if before != after:
            logger.debug(
                "metadata_filter",
                before=before,
                after=after,
                removed=before - after,
            )
        return result

    def _keep(self, chunk: RetrievedChunk) -> bool:
        path = chunk.file_path

        if self._filter_tests:
            for pat in _TEST_PATTERNS:
                if pat.search(path):
                    return False

        if self._filter_generated:
            for pat in _GENERATED_PATTERNS:
                if pat.search(path):
                    return False

        return True
