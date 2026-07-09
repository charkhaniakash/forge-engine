-- Phase 10: Git Operations, Review Preparation & Pull Request Automation
-- Tables for tracking branches, commits, PRs, publishing sessions, and sync history.

-- ── Publishing Sessions ─────────────────────────────────────────────────────
-- Tracks the progress of a single publishing attempt. Enables idempotent
-- resume after partial failures.
CREATE TABLE IF NOT EXISTS publishing_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id        UUID NOT NULL,
    task_execution_id   UUID NOT NULL,
    workspace_id        UUID NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'pending',
        -- pending | verifying | branching | committing | pushing | creating_pr | syncing | completed | failed | cancelled
    current_step        VARCHAR(64),
    branch_name         VARCHAR(256),
    pr_number           INT,
    pr_url              TEXT,
    draft_mode          BOOLEAN NOT NULL DEFAULT false,
    error_message       TEXT,
    cancellation_reason TEXT,
    initiated_by        UUID,  -- user_id who triggered publish
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_publishing_sessions_work_item ON publishing_sessions (work_item_id);
CREATE INDEX idx_publishing_sessions_status ON publishing_sessions (status);

-- Prevent concurrent active sessions for the same work item.
-- Only one session can be in a non-terminal state at a time.
CREATE UNIQUE INDEX idx_publishing_sessions_active_work_item
ON publishing_sessions (work_item_id)
WHERE status NOT IN ('completed', 'failed', 'cancelled');

-- ── Git Branches ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS git_branches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id    UUID NOT NULL,
    session_id      UUID NOT NULL REFERENCES publishing_sessions(id) ON DELETE CASCADE,
    branch_name     VARCHAR(256) NOT NULL,
    base_commit_sha VARCHAR(64) NOT NULL,
    head_commit_sha VARCHAR(64),
    status          VARCHAR(32) NOT NULL DEFAULT 'created',
        -- created | pushed | deleted | conflict
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_git_branches_work_item ON git_branches (work_item_id);
CREATE INDEX idx_git_branches_session ON git_branches (session_id);
CREATE UNIQUE INDEX idx_git_branches_name_work_item ON git_branches (branch_name, work_item_id);

-- ── Git Commits ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS git_commits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id           UUID NOT NULL REFERENCES git_branches(id) ON DELETE CASCADE,
    session_id          UUID NOT NULL REFERENCES publishing_sessions(id) ON DELETE CASCADE,
    commit_sha          VARCHAR(64) NOT NULL,
    message             TEXT NOT NULL,
    author_name         VARCHAR(256) NOT NULL,
    author_email        VARCHAR(256) NOT NULL,
    execution_id        UUID,
    commit_order        INT NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_git_commits_branch ON git_commits (branch_id);
CREATE INDEX idx_git_commits_session ON git_commits (session_id);

-- ── Pull Requests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pull_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id        UUID NOT NULL,
    branch_id           UUID NOT NULL REFERENCES git_branches(id) ON DELETE CASCADE,
    session_id          UUID NOT NULL REFERENCES publishing_sessions(id) ON DELETE CASCADE,
    pr_number           INT NOT NULL,
    github_pr_id        BIGINT,
    url                 TEXT NOT NULL,
    title               VARCHAR(512) NOT NULL,
    state               VARCHAR(32) NOT NULL DEFAULT 'open',
        -- open | closed | merged | draft
    draft               BOOLEAN NOT NULL DEFAULT false,
    review_state        VARCHAR(32),
        -- pending | approved | changes_requested | commented
    mergeable           BOOLEAN,
    head_sha            VARCHAR(64),
    base_branch         VARCHAR(256) NOT NULL,
    additions           INT,
    deletions           INT,
    changed_files       INT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pull_requests_work_item ON pull_requests (work_item_id);
CREATE INDEX idx_pull_requests_branch ON pull_requests (branch_id);
CREATE UNIQUE INDEX idx_pull_requests_number_work_item ON pull_requests (pr_number, work_item_id);

-- ── GitHub Sync History ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS github_sync_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pr_id           UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    session_id      UUID NOT NULL REFERENCES publishing_sessions(id) ON DELETE CASCADE,
    operation       VARCHAR(64) NOT NULL,
        -- fetch_status | fetch_reviews | fetch_mergeability | fetch_ci | update_description | add_comment
    result          VARCHAR(32) NOT NULL,
        -- success | failed | skipped
    error_message   TEXT,
    response_data   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_github_sync_history_pr ON github_sync_history (pr_id);
CREATE INDEX idx_github_sync_history_session ON github_sync_history (session_id);

-- ── Publishing Audit Log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS publishing_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES publishing_sessions(id) ON DELETE CASCADE,
    work_item_id    UUID NOT NULL,
    action          VARCHAR(64) NOT NULL,
        -- session_created | workspace_verified | branch_created | commit_created
        -- | pushed | pr_created | pr_updated | synced | completed | failed
        -- | cancelled | retry
    actor_type      VARCHAR(16) NOT NULL DEFAULT 'system',
        -- system | user
    actor_id        UUID,
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_publishing_audit_work_item ON publishing_audit_log (work_item_id);
CREATE INDEX idx_publishing_audit_session ON publishing_audit_log (session_id);
CREATE INDEX idx_publishing_audit_action ON publishing_audit_log (action);

-- ── Work Item Status Extension ──────────────────────────────────────────────
-- Add 'publishing' and 'published' to the work item status machine.
-- (This is safe: status is stored as VARCHAR, not an enum.)
