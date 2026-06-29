"""
CandidateGenerator: Protocol + VectorCandidateGenerator (Phase 4 implementation).

The CandidateGenerator is the first stage of the RetrievalEngine.
It fetches a large candidate set from the vector index. Subsequent stages
(filter, re-rank, diversity) narrow this set before context assembly.

Future retrievers (hybrid keyword+vector, symbol graph expansion) implement
the same Protocol and are composed inside RetrievalEngine without touching
the pipeline.
"""
from __future__ import annotations

import time
from typing import Protocol, runtime_checkable

import psycopg2
import psycopg2.extras
import structlog

from src.config import settings
from src.core.models import RetrievalScope, RetrievedChunk

logger = structlog.get_logger()


@runtime_checkable
class CandidateGenerator(Protocol):
    """Protocol for the candidate-generation stage of retrieval.

    Implementations fetch an unordered candidate set. The caller is
    responsible for ordering, filtering, and diversity.
    """

    def generate(
        self,
        query_vector: list[float],
        scope: RetrievalScope,
        top_k: int,
    ) -> list[RetrievedChunk]:
        """Return up to top_k candidate chunks for the given scope.

        Chunks are ordered by cosine similarity descending.
        The score field reflects the raw cosine similarity score.
        """
        ...


class VectorCandidateGenerator:
    """Phase 4 implementation: pure pgvector cosine similarity search.

    Queries code_chunks WHERE (repo_id, commit_sha) is in the scope AND the
    associated ingestion_job has status = 'done' (retrieval gate from ADR 0004).

    For multi-repo scope (future), the query searches all matching
    (repo_id, commit_sha) pairs in a single round-trip.
    """

    def generate(
        self,
        query_vector: list[float],
        scope: RetrievalScope,
        top_k: int,
    ) -> list[RetrievedChunk]:
        t0 = time.monotonic()

        if not scope.repo_ids:
            return []

        # Build the (repo_id, commit_sha) filter for the scope.
        # Phase 4: always one pair. Future: multiple pairs handled identically.
        scope_pairs = [
            (repo_id, scope.commit_shas[repo_id])
            for repo_id in scope.repo_ids
            if repo_id in scope.commit_shas
        ]
        if not scope_pairs:
            return []

        results = self._query(query_vector, scope_pairs, top_k)

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "vector_candidate_generator",
            candidate_count=len(results),
            top_k=top_k,
            elapsed_ms=elapsed_ms,
            repo_count=len(scope_pairs),
        )
        return results

    def _query(
        self,
        query_vector: list[float],
        scope_pairs: list[tuple[str, str]],
        top_k: int,
    ) -> list[RetrievedChunk]:
        vector_str = "[" + ",".join(str(x) for x in query_vector) + "]"

        # Build parameterised filters for the (repo_id, commit_sha) scope pairs.
        # We use explicit OR conditions instead of a VALUES subquery to avoid
        # column-name ambiguity in the ON clause across PostgreSQL versions.
        # Phase 4 always has one pair; future multi-repo passes multiple.
        conditions = " OR ".join(
            "(cc.repo_id = %s::uuid AND cc.commit_sha = %s)"
            for _ in scope_pairs
        )
        flat_pairs: list[str] = []
        for repo_id, commit_sha in scope_pairs:
            flat_pairs.extend([repo_id, commit_sha])

        logger.info(
            "vector_search_params",
            scope_pairs=[(r, c[:8] if c else "") for r, c in scope_pairs],
            top_k=top_k,
            vector_dims=len(query_vector),
        )

        sql = f"""
            SELECT
                cc.id,
                cc.repo_id::text,
                cc.commit_sha,
                cc.file_path,
                cc.start_line,
                cc.end_line,
                cc.content,
                cc.language,
                cc.chunk_type,
                cc.name          AS symbol_name,
                cc.token_count,
                1 - (cc.embedding <=> %s::vector)  AS score
            FROM code_chunks cc
            -- Retrieval gate (ADR 0004): only chunks from completed jobs.
            INNER JOIN ingestion_jobs ij
                ON ij.id = cc.job_id AND ij.status = 'done'
            -- Scope filter: match the (repo_id, commit_sha) pairs exactly.
            WHERE ({conditions})
              AND cc.embedding IS NOT NULL
            ORDER BY cc.embedding <=> %s::vector
            LIMIT %s
        """

        # params: vector first (for SELECT), then flat_pairs (for WHERE), then vector (for ORDER BY), then limit
        params = [vector_str] + flat_pairs + [vector_str, top_k]

        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
                logger.info(
                    "vector_search_result",
                    rows_returned=len(rows),
                    top_k=top_k,
                )
        finally:
            conn.close()

        chunks = []
        for row in rows:
            (
                chunk_id, repo_id, commit_sha, file_path,
                start_line, end_line, content,
                language, chunk_type, symbol_name, token_count, score,
            ) = row
            chunks.append(RetrievedChunk(
                id=str(chunk_id),
                repo_id=str(repo_id),
                commit_sha=commit_sha,
                file_path=file_path,
                start_line=start_line,
                end_line=end_line,
                content=content,
                language=language,
                chunk_type=chunk_type,
                symbol_name=symbol_name,
                token_count=token_count,
                score=float(score) if score is not None else 0.0,
            ))
        return chunks
