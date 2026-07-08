-- Migration 010: task execution tables (Phase 7)
--
-- task_executions: one row per execution attempt of a work item.
--   Go owns every status transition. The agent never writes here.
--
-- step_executions: one row per plan step within an execution.
--
-- execution_events: ordered event log for every tool call, reasoning note,
--   deviation, and lifecycle transition within an execution.
--   tool_call_id enables idempotent tool dispatch: duplicate calls return
--   the cached result without re-executing.
--
-- code_diffs: structured diff computed by Go (not the agent) for every
--   file modification. The agent sends new content; Go diffs it.
--
-- execution_checkpoints: persisted after every completed step so Phase 12
--   can resume execution from the last successful checkpoint.

CREATE TABLE task_executions (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id            UUID        NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    workspace_id            UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_id                 UUID        NOT NULL REFERENCES plans(id),

    -- Lifecycle — owned entirely by Go.
    -- pending → running → completed | failed | cancelled | paused (Phase 12)
    status                  VARCHAR(32) NOT NULL DEFAULT 'pending',

    -- The stable_id of the step currently being executed (NULL when not running).
    current_step_stable_id  TEXT        NULL,

    -- Execution configuration resolved at start time (from org policy / defaults).
    -- Stored here so the full execution is reproducible and auditable.
    execution_context       JSONB       NOT NULL DEFAULT '{}',

    started_at              TIMESTAMPTZ NULL,
    completed_at            TIMESTAMPTZ NULL,
    error                   TEXT        NULL,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_executions_work_item ON task_executions(work_item_id);
CREATE INDEX idx_task_executions_status    ON task_executions(status)
    WHERE status NOT IN ('completed', 'failed', 'cancelled');


CREATE TABLE step_executions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id   UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,

    -- Matches the plan step's stable_id — stable across plan versions.
    step_stable_id      VARCHAR(64) NOT NULL,
    step_order          INT         NOT NULL,

    -- pending → running → completed | failed | skipped | deviated
    status              VARCHAR(32) NOT NULL DEFAULT 'pending',

    started_at          TIMESTAMPTZ NULL,
    completed_at        TIMESTAMPTZ NULL,

    -- Agent's explanation for what it did this step.
    reasoning           TEXT        NULL,

    -- Populated when the agent detects a plan assumption is wrong.
    deviation_note      TEXT        NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_step_executions_task ON step_executions(task_execution_id, step_order);


CREATE TABLE execution_events (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id   UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
    step_execution_id   UUID        NULL REFERENCES step_executions(id) ON DELETE CASCADE,

    -- Monotonically incrementing per task_execution (global across all steps).
    seq                 INT         NOT NULL,

    -- Event classification.
    -- tool_call | tool_result | reasoning | deviation |
    -- step_start | step_complete | exec_start | exec_complete | error
    event_type          VARCHAR(32) NOT NULL,

    -- Tool call fields (event_type IN ('tool_call', 'tool_result')).
    tool_name           VARCHAR(64) NULL,
    tool_args           JSONB       NULL,
    tool_result         JSONB       NULL,

    -- Idempotency key: Go stores this on tool_call events and checks it
    -- before executing. Duplicate tool_call_id → return cached tool_result.
    tool_call_id        UUID        NULL,

    -- Human-readable message for reasoning/deviation/lifecycle events.
    message             TEXT        NULL,

    success             BOOLEAN     NULL,
    duration_ms         INT         NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (task_execution_id, seq)
);

-- Separate non-deferrable unique index for tool_call_id idempotency.
-- ON CONFLICT requires a non-deferrable constraint; DEFERRABLE breaks it.
CREATE UNIQUE INDEX idx_execution_events_tool_call_id
    ON execution_events(task_execution_id, tool_call_id)
    WHERE tool_call_id IS NOT NULL;

CREATE INDEX idx_execution_events_task ON execution_events(task_execution_id, seq);
CREATE INDEX idx_execution_events_step ON execution_events(step_execution_id);


CREATE TABLE code_diffs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id   UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
    -- NULL for repair-originated writes (repair has no step_execution context).
    step_execution_id   UUID        NULL REFERENCES step_executions(id) ON DELETE CASCADE,

    file_path           TEXT        NOT NULL,

    -- modify | create | delete | rename
    operation           VARCHAR(16) NOT NULL,

    -- Populated for rename operations only.
    old_path            TEXT        NULL,

    -- Unified diff computed by Go. NULL for creates/deletes (no meaningful diff).
    diff_unified        TEXT        NULL,

    lines_added         INT         NOT NULL DEFAULT 0,
    lines_removed       INT         NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_code_diffs_task ON code_diffs(task_execution_id);
CREATE INDEX idx_code_diffs_step ON code_diffs(step_execution_id);


CREATE TABLE execution_checkpoints (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id   UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,

    -- The step that just completed when this checkpoint was written.
    step_stable_id      VARCHAR(64) NOT NULL,
    step_order          INT         NOT NULL,

    -- Snapshot of which files were modified up to and including this step.
    modified_files      TEXT[]      NOT NULL DEFAULT '{}',
    created_files       TEXT[]      NOT NULL DEFAULT '{}',
    deleted_files       TEXT[]      NOT NULL DEFAULT '{}',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Only one checkpoint per step per execution.
    UNIQUE (task_execution_id, step_stable_id)
);

CREATE INDEX idx_execution_checkpoints_task ON execution_checkpoints(task_execution_id, step_order DESC);
