"""
RetrievalEngine: composes the four retrieval stages into one callable.

pipeline.py calls retrieval_engine.retrieve(...) and receives a RetrievalResult.
The pipeline never knows which concrete implementations are wired in.

Stages:
  1. CandidateGenerator  — fetch top-K from pgvector
  2. MetadataFilter      — remove test/generated files (configurable per profile)
  3. Reranker            — cosine + keyword score
  4. DiversitySelector   — enforce per-file cap

Profile system (Phase 5):
  retrieve() accepts an optional RetrievalProfile dataclass that carries
  all tuning knobs. Q&A uses the default (qa) profile. Planning uses the
  planning profile with broader k-values and test files included.
  The engine logic is identical across all profiles.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import structlog

from src.config import settings
from src.core.candidate_generator import CandidateGenerator, VectorCandidateGenerator
from src.core.diversity_selector import DiversitySelector
from src.core.metadata_filter import MetadataFilter
from src.core.models import RetrievalResult, RetrievalScope, RetrievedChunk
from src.core.reranker import Reranker

logger = structlog.get_logger()


@dataclass
class RetrievalProfile:
    """All tuning knobs for one retrieval use-case.

    Each capability (Q&A, planning, execution) constructs its own profile
    from settings. The RetrievalEngine is identical across all profiles —
    only the profile values differ.
    """
    name: str
    candidate_k: int
    rerank_k: int
    final_k: int
    max_chunks_per_file: int
    context_token_budget: int
    include_tests: bool = False

    @classmethod
    def qa(cls) -> "RetrievalProfile":
        """Standard Q&A profile — excludes test files, focused context."""
        cfg = settings.retrieval
        return cls(
            name="qa",
            candidate_k=cfg.candidate_k,
            rerank_k=cfg.rerank_k,
            final_k=cfg.final_k,
            max_chunks_per_file=cfg.max_chunks_per_file,
            context_token_budget=cfg.context_token_budget,
            include_tests=False,
        )

    @classmethod
    def planning(cls) -> "RetrievalProfile":
        """Planning profile — broader retrieval, includes test files for constraint awareness."""
        cfg = settings.retrieval
        return cls(
            name="planning",
            candidate_k=cfg.planning_candidate_k,
            rerank_k=cfg.planning_rerank_k,
            final_k=cfg.planning_final_k,
            max_chunks_per_file=cfg.planning_max_chunks_per_file,
            context_token_budget=cfg.planning_context_token_budget,
            include_tests=cfg.planning_include_tests,
        )


class RetrievalEngine:
    """Orchestrates the four retrieval stages.

    Accepts injected implementations for testability. Default arguments wire
    the Phase 4 concrete implementations.

    Usage:
        # Q&A (default profile)
        result = engine.retrieve(vector, question, scope)

        # Planning (broader profile)
        result = engine.retrieve(vector, intent, scope,
                                  profile=RetrievalProfile.planning())
    """

    def __init__(
        self,
        candidate_generator: CandidateGenerator | None = None,
        reranker: Reranker | None = None,
    ) -> None:
        # Inject concrete implementations; profile controls filter/selector config.
        self._gen = candidate_generator or VectorCandidateGenerator()
        self._reranker = reranker or Reranker()

    def retrieve(
        self,
        query_vector: list[float],
        question: str,
        scope: RetrievalScope,
        profile: RetrievalProfile | None = None,
    ) -> RetrievalResult:
        """Run the full four-stage pipeline and return a RetrievalResult.

        query_vector: embedding of the user question / intent.
        question:     raw text (used for keyword re-ranking).
        scope:        which (repo_id, commit_sha) pairs to search.
        profile:      retrieval profile; defaults to RetrievalProfile.qa().
        """
        if profile is None:
            profile = RetrievalProfile.qa()

        t0 = time.monotonic()

        # Build stage instances from the profile.
        meta_filter = MetadataFilter(filter_tests=not profile.include_tests)
        selector = DiversitySelector(
            max_per_file=profile.max_chunks_per_file,
            final_k=profile.final_k,
        )

        # Stage 1: candidate generation
        candidates: list[RetrievedChunk] = self._gen.generate(
            query_vector, scope, top_k=profile.candidate_k
        )
        candidate_count = len(candidates)

        # Stage 2: metadata filter
        filtered = meta_filter.filter(candidates)
        filtered_count = len(filtered)

        # Stage 3: re-rank (also trims to rerank_k)
        reranked = self._reranker.rerank(filtered, question)
        reranked = reranked[: profile.rerank_k]
        reranked_count = len(reranked)

        # Stage 4: diversity selection
        final = selector.select(reranked)
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
            profile=profile.name,
            strategy=result.strategy,
            timing_ms=timing_ms,
            candidate_count=candidate_count,
            filtered_count=filtered_count,
            reranked_count=reranked_count,
            final_count=final_count,
        )

        return result
