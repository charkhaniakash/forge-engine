-- Migration 006: pgvector extension + code_chunks table
-- Stores parsed, chunked, and embedded content from indexed repositories.
-- Retrieval (Phase 4+) must only read rows where the associated ingestion_job
-- has status = 'done'. Partially indexed repos are never queryable.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS code_chunks (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Snapshot key: (repo_id, commit_sha) identifies an immutable repository snapshot.
    repo_id          UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
    job_id           UUID        NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    commit_sha       VARCHAR(40) NOT NULL,

    -- Source location
    file_path        TEXT        NOT NULL,
    language         VARCHAR(64),
    start_line       INT         NOT NULL,
    end_line         INT         NOT NULL,

    -- Chunk classification
    chunk_type       VARCHAR(64),   -- function | class | block | file
    name             TEXT,

    -- Content
    content          TEXT        NOT NULL,
    token_count      INT,

    -- Parser provenance
    parser_name      VARCHAR(128),
    parser_version   VARCHAR(64),

    -- Embeddings
    embedding_model  VARCHAR(128),
    embedding        vector(768),   -- Gemini text-embedding-004

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
ON code_chunks
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Fast lookup by repository snapshot
CREATE INDEX IF NOT EXISTS idx_code_chunks_repo_commit
ON code_chunks(repo_id, commit_sha);

-- Fast lookup by ingestion job
CREATE INDEX IF NOT EXISTS idx_code_chunks_job_id
ON code_chunks(job_id);