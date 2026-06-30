-- Migration 005: ingestion_jobs table
-- Tracks the lifecycle of every repository ingestion job.
-- Each row represents one attempt to index a repo at a specific commit SHA.

CREATE TABLE ingestion_jobs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id          UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
    commit_sha       VARCHAR(40) NOT NULL,
    trigger_type     VARCHAR(32) NOT NULL,   -- 'installation_sync' | 'push' | 'manual'

    -- Lifecycle
    status           VARCHAR(32) NOT NULL DEFAULT 'queued',
                                            -- queued | running | done | failed | superseded
    progress_stage   VARCHAR(32),           -- cloning | parsing | chunking | embedding | persisting | completed
    queued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,

    -- Operational debugging
    worker_id        TEXT,                  -- hostname:pid of the worker that picked this job

    -- Progress counters (updated in real-time by the worker as Agent events arrive)
    total_chunks     INT,
    processed_chunks INT         NOT NULL DEFAULT 0,

    -- Failure detail
    error            TEXT,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup of the latest job for a repo (used by status endpoint and supersede logic)
CREATE INDEX idx_ingestion_jobs_repo_id         ON ingestion_jobs(repo_id);
CREATE INDEX idx_ingestion_jobs_repo_status     ON ingestion_jobs(repo_id, status);
CREATE INDEX idx_ingestion_jobs_queued_at       ON ingestion_jobs(queued_at);
