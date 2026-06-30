"""
Reranker: scores and sorts the filtered candidate set.

Combines two signals:
  1. Cosine similarity score from pgvector (already in chunk.score)
  2. Keyword overlap between the question tokens and the chunk content

Final score = cosine_weight * cosine_score + keyword_weight * keyword_score

No additional API calls — purely local computation.
"""
from __future__ import annotations

import re
import structlog

from src.core.models import RetrievedChunk

logger = structlog.get_logger()

# Weights for the combined score.
_COSINE_WEIGHT = 0.7
_KEYWORD_WEIGHT = 0.3

# Minimum token length for keyword matching (filters stop words cheaply).
_MIN_TOKEN_LEN = 3


def _tokenise(text: str) -> set[str]:
    """Lower-case word tokens, minimum length 3."""
    return {
        t.lower()
        for t in re.split(r"\W+", text)
        if len(t) >= _MIN_TOKEN_LEN
    }


class Reranker:
    """Reranks chunks by combined cosine + keyword overlap score."""

    def rerank(
        self,
        chunks: list[RetrievedChunk],
        question: str,
    ) -> list[RetrievedChunk]:
        """Return chunks sorted by combined score, descending."""
        if not chunks:
            return []

        question_tokens = _tokenise(question)
        scored = [self._score(c, question_tokens) for c in chunks]
        scored.sort(key=lambda c: c.score, reverse=True)

        logger.debug(
            "reranker",
            input_count=len(chunks),
            output_count=len(scored),
            top_score=round(scored[0].score, 4) if scored else 0,
        )
        return scored

    def _score(
        self,
        chunk: RetrievedChunk,
        question_tokens: set[str],
    ) -> RetrievedChunk:
        """Return a new RetrievedChunk with updated score."""
        cosine = max(0.0, min(1.0, chunk.score))  # clamp to [0, 1]

        chunk_tokens = _tokenise(chunk.content)
        if question_tokens and chunk_tokens:
            overlap = len(question_tokens & chunk_tokens)
            keyword = overlap / len(question_tokens)
        else:
            keyword = 0.0

        combined = _COSINE_WEIGHT * cosine + _KEYWORD_WEIGHT * keyword

        # Return a shallow copy with updated score.
        import dataclasses
        return dataclasses.replace(chunk, score=combined)
