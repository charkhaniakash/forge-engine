"""
RetrievalEngine: composes the four retrieval stages into one callable.

pipeline.py calls retrieval_engine.retrieve(...) and receives a RetrievalResult.
The pipeline never knows which concrete implementations are wired in.

Stages:
  1. CandidateGenerator  — fetch top-K from pgvector
  2. MetadataFilter      — remove test/generated files
  3. Reranker            — cosine + keyword score
  4. DiversitySelector   — enforce per-file cap

Observability: RetrievalResult carries counts and timing for every stage,
logged as a single structured line by the pipeline.
"""
from __future__ import annotations

import time

import structlog

from src.config import settings
from src.core.candidate_generator import CandidateGenerator, VectorCandidateGenerator
from src.core.context_assembler import ContextAssembler, LinearContextAssembler
from src.core.diversity_selector import DiversitySelector
from src.core.metadata_filter import MetadataFilter
from src.core.models import AssembledContext, RetrievalResult, RetrievalScope, RetrievedChunk
from src.core.reranker import Reranker

logger = structlog.get_logger()


class RetrievalEngine:
    """Orchestrates the four retrieval stages.

    Accepts injected implementations for testability. Default arguments wire
    the Phase 4 concrete implementations.
    """

    def __init__(
        self,
        candidate_generator: CandidateGenerator | None = None,
        metadata_filter: MetadataFilter | None = None,
        reranker: Reranker | None = None,
        diversity_selector: DiversitySelector | None = None,
    ) -> None:
        cfg = settings.retrieval
        self._gen = candidate_generator or VectorCandidateGenerator()
        self._filter = metadata_filter or MetadataFilter()
        self._reranker = reranker or Reranker()
        self._selector = diversity_selector or DiversitySelector(
            max_per_file=cfg.max_chunks_per_file,
            final_k=cfg.final_k,
        )

    def retrieve(
        self,
        query_vector: list[float],
        question: str,
        scope: RetrievalScope,
    ) -> RetrievalResult:
        """Run the full four-stage pipeline and return a RetrievalResult.

        query_vector: embedding of the user question.
        question:     raw question text (used for keyword re-ranking).
        scope:        which (repo_id, commit_sha) pairs to search.
        """
        cfg = settings.retrieval
        t0 = time.monotonic()

        # Stage 1: candidate generation
        candidates: list[RetrievedChunk] = self._gen.generate(
            query_vector, scope, top_k=cfg.candidate_k
        )
        candidate_count = len(candidates)

        # Stage 2: metadata filter
        filtered = self._filter.filter(candidates)
        filtered_count = len(filtered)

        # Stage 3: re-rank (also trims to rerank_k)
        reranked = self._reranker.rerank(filtered, question)
        reranked = reranked[: cfg.rerank_k]
        reranked_count = len(reranked)

        # Stage 4: diversity selection
        final = self._selector.select(reranked)
        final_count = len(final)

        timing_ms = int((time.monotonic() - t0) * 1000)

        result = RetrievalResult(
            chunks=final,
            strategy="vector",
            timing_ms=timing_ms,
            candidate_count=candidate_count,
            filtered_count=filtered_count,
            reranked_count=reranked_count,
            final_count=final_count,
        )

        logger.info(
            "retrieval_trace",
            strategy=result.strategy,
            timing_ms=timing_ms,
            candidate_count=candidate_count,
            filtered_count=filtered_count,
            reranked_count=reranked_count,
            final_count=final_count,
        )

        return result
