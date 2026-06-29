"""
Vector store: writes code_chunks rows directly to PostgreSQL using psycopg2.

Design rules (ADR 0004):
  - Chunks are written incrementally as embeddings are generated.
  - Retrieval (Phase 4) must only query chunks where the associated
    ingestion_job has status = 'done'. This file does not enforce that
    gate — it only writes. The gate is enforced by the retrieval layer.
  - This module never reads from the filesystem.
"""
from __future__ import annotations

import uuid
from typing import Optional

import psycopg2
import psycopg2.extras

from src.config import settings
from src.ingestion.parser.base import ParsedChunk

import structlog

logger = structlog.get_logger()

# Register UUID adapter so we can pass uuid.UUID objects directly.
psycopg2.extras.register_uuid()


def _get_connection() -> psycopg2.extensions.connection:
    """Open a new database connection. Caller is responsible for closing."""
    return psycopg2.connect(settings.database_url)


def write_chunks(
    chunks: list[ParsedChunk],
    embeddings: list[list[float]],
    repo_id: str,
    job_id: str,
    commit_sha: str,
) -> int:
    """
    Insert a batch of chunks with their embeddings into code_chunks.
    Returns the number of rows inserted.

    Embeddings must be in the same order as chunks. If an embedding is
    an empty list (failed embedding), the row is still written with
    embedding = NULL so re-embedding can be triggered later.
    """
    if not chunks:
        return 0

    assert len(chunks) == len(embeddings), (
        f"chunks ({len(chunks)}) and embeddings ({len(embeddings)}) length mismatch"
    )

    with_embeddings = sum(1 for e in embeddings if e)
    without_embeddings = len(embeddings) - with_embeddings
    logger.info(
        "vector_store_write_start",
        total=len(chunks),
        with_embeddings=with_embeddings,
        without_embeddings=without_embeddings,
        job_id=job_id,
    )

    rows = []
    for chunk, embedding in zip(chunks, embeddings):
        # pgvector expects the vector as a Python list of floats.
        # NULL is stored when embedding is empty (e.g. API error on that batch).
        emb_value = embedding if embedding else None
        emb_model = settings.embedding_model if emb_value else None

        rows.append((
            str(uuid.uuid4()),   # id
            repo_id,             # repo_id
            job_id,              # job_id
            commit_sha,          # commit_sha
            chunk.file_path,     # file_path
            chunk.language,      # language
            chunk.start_line,    # start_line
            chunk.end_line,      # end_line
            chunk.chunk_type,    # chunk_type
            chunk.name,          # name (nullable)
            chunk.content,       # content
            chunk.token_count,   # token_count (nullable)
            chunk.parser_name,   # parser_name
            chunk.parser_version,# parser_version
            emb_model,           # embedding_model (NULL when no embedding)
            emb_value,           # embedding (nullable vector)
        ))

    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                # The ::vector cast is required — psycopg2 passes Python lists
                # as arrays, and pgvector needs an explicit cast to vector.
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO code_chunks (
                        id, repo_id, job_id, commit_sha,
                        file_path, language, start_line, end_line,
                        chunk_type, name, content, token_count,
                        parser_name, parser_version,
                        embedding_model, embedding
                    ) VALUES %s
                    """,
                    rows,
                    template=(
                        "(%s, %s, %s, %s,"
                        " %s, %s, %s, %s,"
                        " %s, %s, %s, %s,"
                        " %s, %s,"
                        " %s, %s::vector)"
                    ),
                )
        logger.info(
            "vector_store_write_done",
            rows_inserted=len(rows),
            with_embeddings=with_embeddings,
            job_id=job_id,
        )
        return len(rows)
    except Exception as exc:
        logger.error(
            "vector_store_write_failed",
            error=str(exc),
            job_id=job_id,
            total=len(rows),
        )
        raise
    finally:
        conn.close()


def delete_chunks_for_job(job_id: str) -> int:
    """
    Delete all chunks associated with a job. Used when a job is re-run
    after partial failure to avoid duplicate rows.
    Returns the number of rows deleted.
    """
    conn = _get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM code_chunks WHERE job_id = %s", (job_id,)
                )
                return cur.rowcount
    finally:
        conn.close()
