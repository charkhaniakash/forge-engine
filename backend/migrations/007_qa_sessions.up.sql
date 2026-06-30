-- Migration 007: Q&A sessions and messages (Phase 4)
--
-- qa_sessions: one row per conversation. Pinned to a single (repo_id, commit_sha)
--   snapshot at creation time. workspace_id is NULL in Phase 4 and will be
--   populated when workspaces are introduced in a later phase.
--
-- qa_messages: individual turns (role=user|assistant). Citations are stored as
--   JSONB — each element is a rich citation object (see Phase 4 architecture doc).
--
-- Retrieval gate: sessions must only be answered against a commit_sha that has
--   a corresponding ingestion_jobs row with status = 'done'. This is enforced
--   at the application layer (QAHandlers.Ask), not by a DB constraint, because
--   the done job may be deleted by future GC while the session still exists.

CREATE TABLE qa_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id         UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
    org_id          UUID        NOT NULL,
    user_id         UUID        NOT NULL,

    -- Snapshot this session is pinned to. Resolved at session creation from
    -- the latest ingestion_jobs row with status = 'done' for this repo.
    commit_sha      VARCHAR(40) NOT NULL,

    -- Set from the first user message (truncated to 120 chars).
    -- NULL until the first message is persisted.
    title           TEXT,

    -- Phase 5+: workspace grouping. NULL in Phase 4.
    workspace_id    UUID        NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qa_sessions_repo_id  ON qa_sessions(repo_id);
CREATE INDEX idx_qa_sessions_org_user ON qa_sessions(org_id, user_id);
-- GC anchor: used by the snapshot retention job to detect referenced snapshots.
CREATE INDEX idx_qa_sessions_commit   ON qa_sessions(repo_id, commit_sha);


CREATE TABLE qa_messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID        NOT NULL REFERENCES qa_sessions(id) ON DELETE CASCADE,

    -- 'user' or 'assistant'
    role            VARCHAR(16) NOT NULL,
    content         TEXT        NOT NULL,

    -- Rich citation objects for assistant messages. Each element:
    --   { chunk_id, commit_sha, file_path, start_line, end_line,
    --     language, chunk_type, symbol_name }
    -- NULL for user messages and assistant messages with no retrieved context.
    citations       JSONB       NULL,

    -- Populated for assistant messages only.
    token_count     INT         NULL,
    model           VARCHAR(128) NULL,

    -- Echo of the request_id sent in the POST /ask body. Used to correlate
    -- WebSocket token events with the persisted message.
    request_id      UUID        NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qa_messages_session  ON qa_messages(session_id, created_at);
