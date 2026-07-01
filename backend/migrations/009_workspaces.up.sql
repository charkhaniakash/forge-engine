-- Migration 009: workspaces + execution_logs (Phase 6)
--
-- workspaces: one row per sandbox execution environment.
--   Each workspace is tied to exactly one work_item execution attempt.
--   The container_id is an opaque handle owned by the SandboxDriver.
--   All fields above the driver layer use workspace terminology; Docker
--   is an implementation detail stored here but never surfaced in APIs.
--
-- execution_logs: unified event log for every workspace lifecycle event
--   and every command executed inside the workspace. This table powers
--   the Devin-style live worklog UI in future phases and feeds Phase 13
--   observability/cost tracking.
--
-- Approval gate (enforced by Go, not DB):
--   A workspace can only be provisioned when work_item.approval_status
--   IN ('approved', 'auto_approved'). The handler checks this before
--   calling WorkspaceManager.Provision().

CREATE TABLE workspaces (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ties this workspace to exactly one task execution attempt.
    work_item_id     UUID        NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    repo_id          UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,

    -- The commit this workspace is checked out to.
    commit_sha       VARCHAR(40) NOT NULL,

    -- Which SandboxDriver implementation manages this workspace.
    -- Phase 6: always 'docker'. Future: 'firecracker', 'fargate', etc.
    driver           VARCHAR(32) NOT NULL DEFAULT 'docker',

    -- Opaque driver-level handle (Docker container ID).
    -- NULL while status='provisioning', set after container is created.
    container_id     TEXT        NULL,
    container_name   TEXT        NULL,

    -- Resource limits enforced by the driver.
    image            VARCHAR(256) NOT NULL DEFAULT 'forge-sandbox:latest',
    cpu_limit        VARCHAR(16) NOT NULL DEFAULT '1.0',
    memory_limit_mb  INT         NOT NULL DEFAULT 512,
    pid_limit        INT         NOT NULL DEFAULT 128,

    -- Hard wall-clock timeout for the entire workspace lifetime (seconds).
    -- The WorkspaceReaper destroys the workspace after this elapses.
    timeout_seconds  INT         NOT NULL DEFAULT 1800,

    -- Lifecycle
    status           VARCHAR(32) NOT NULL DEFAULT 'provisioning',
    -- provisioning → ready → executing → completed | failed | timed_out | killed
    -- All terminal states → destroyed via destroying → destroyed

    started_at       TIMESTAMPTZ NULL,   -- container started
    ready_at         TIMESTAMPTZ NULL,   -- repo cloned, checkout done
    destroyed_at     TIMESTAMPTZ NULL,
    error            TEXT        NULL,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspaces_work_item_id ON workspaces(work_item_id);
CREATE INDEX idx_workspaces_status       ON workspaces(status)
    WHERE status NOT IN ('destroyed');  -- reaper only scans live workspaces


CREATE TABLE execution_logs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Monotonically incrementing per workspace. Used for ordered replay
    -- (Phase 11) and the live worklog UI (Phase 7+).
    seq              INT         NOT NULL,

    -- 'lifecycle' events record workspace state transitions and git operations.
    -- 'command'   events record commands executed via ExecutionService.
    event_type       VARCHAR(32) NOT NULL,

    -- Lifecycle event name (only set when event_type='lifecycle').
    -- Values: workspace_creating | workspace_created | repo_cloning |
    --         repo_cloned | repo_checkout | workspace_ready |
    --         workspace_destroying | workspace_destroyed | workspace_failed
    lifecycle_event  VARCHAR(64) NULL,

    -- Command fields (only set when event_type='command').
    command          TEXT[]      NULL,   -- argv array — NEVER a shell string
    working_dir      VARCHAR(512) NULL,  -- relative path inside /workspace
    exit_code        INT         NULL,   -- NULL while running
    timed_out        BOOLEAN     NOT NULL DEFAULT FALSE,
    timeout_seconds  INT         NULL,
    duration_ms      INT         NULL,

    -- Output: stdout/stderr for commands; message for lifecycle events.
    stdout           TEXT        NULL,
    stderr           TEXT        NULL,
    message          TEXT        NULL,

    started_at       TIMESTAMPTZ NULL,
    completed_at     TIMESTAMPTZ NULL,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workspace_id, seq)
);

CREATE INDEX idx_execution_logs_workspace_id ON execution_logs(workspace_id, seq);
