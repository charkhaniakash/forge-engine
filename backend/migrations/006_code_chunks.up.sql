-- Migration 006: pgvector extension + code_chunks table
-- Stores parsed, chunked, and embedded content from indexed repositories.
-- Retrieval (Phase 4+) must only read rows where the associated ingestion_job
-- has status = 'done'. Partially indexed repos are never queryable.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE code_chunks (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Snapshot key: (repo_id, commit_sha) identifies an immutable repository snapshot.
    -- Future phases may introduce a first-class symbols table above this level;
    -- a symbol_id FK column can be added without touching existing data.
    repo_id          UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
    job_id           UUID        NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    commit_sha       VARCHAR(40) NOT NULL,

    -- Source location
    file_path        TEXT        NOT NULL,
    language         VARCHAR(64),
    start_line       INT         NOT NULL,
    end_line         INT         NOT NULL,

    -- Chunk classification
    chunk_type       VARCHAR(64),   -- 'function' | 'class' | 'block' | 'file'
    name             TEXT,          -- symbol name when chunk_type is function or class

    -- Content
    content          TEXT        NOT NULL,
    token_count      INT,           -- stored for Phase 4 context budget management

    -- Parser provenance — allows selective re-indexing when parsers change
    parser_name      VARCHAR(128),  -- e.g. 'tree-sitter-python', 'line-based'
    parser_version   VARCHAR(64),   -- e.g. '0.21.0'

    -- Embedding — nullable: written after content is persisted.
    -- Re-embedding is: WHERE embedding IS NULL AND job_id = $job_id
    -- Default provider is Gemini text-embedding-004 which produces 768-dim vectors.
    -- If switching to OpenAI text-embedding-3-small (1536-dim), alter this column
    -- type and re-index all repositories.
    embedding_model  VARCHAR(128),  -- e.g. 'models/text-embedding-004'
    embedding        vector(768),   -- dimension matches Gemini text-embedding-004

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector similarity search (cosine distance)
-- lists=100 is a reasonable default for Phase 3 dataset sizes.
CREATE INDEX idx_code_chunks_embedding ON code_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Fast lookup by snapshot key (used by retrieval in Phase 4)
CREATE INDEX idx_code_chunks_repo_commit ON code_chunks(repo_id, commit_sha);

-- Fast lookup by job (used for progress queries and re-embedding)
CREATE INDEX idx_code_chunks_job_id ON code_chunks(job_id);
