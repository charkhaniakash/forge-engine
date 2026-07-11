-- Migration 012: Phase 9 — Autonomous Self-Repair & Recovery Loop
--
-- repair_sessions:   one per validation run that triggers repair
-- repair_attempts:   one row per Go-initiated RepairGraph invocation
-- repair_checkpoints: workspace snapshot enabling deterministic rollback

CREATE TABLE repair_sessions (
    id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id           UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
    workspace_id                UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    trigger_validation_run_id   UUID        NOT NULL REFERENCES validation_runs(id),
    max_attempts                INT         NOT NULL DEFAULT 3,
    attempts_used               INT         NOT NULL DEFAULT 0,
    max_duration_secs           INT         NOT NULL DEFAULT 1800,
    -- running | completed | exhausted | escalated | cancelled
    status                      VARCHAR(16) NOT NULL DEFAULT 'running',
    final_validation_run_id     UUID        NULL REFERENCES validation_runs(id),
    escalation_reason           TEXT        NULL,
    started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at                TIMESTAMPTZ NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repair_sessions_task ON repair_sessions(task_execution_id);
CREATE INDEX idx_repair_sessions_status ON repair_sessions(status)
    WHERE status = 'running';


CREATE TABLE repair_attempts (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repair_session_id   UUID        NOT NULL REFERENCES repair_sessions(id) ON DELETE CASCADE,
    attempt_number      INT         NOT NULL,
    diagnostics_input   JSONB       NOT NULL DEFAULT '[]',
    -- JSONB so schema can evolve: summary, chain_of_decisions, retrieved_files, etc.
    reasoning           JSONB       NULL,
    strategy            VARCHAR(64) NULL,
    -- DOUBLE PRECISION consistent with float64 used elsewhere
    confidence          DOUBLE PRECISION NULL,
    modified_files      TEXT[]      NOT NULL DEFAULT '{}',
    validation_run_id   UUID        NULL REFERENCES validation_runs(id),
    -- improved | no_change | regressed | error
    outcome             VARCHAR(16) NULL,
    -- Version tag for debugging when prompts/graph change
    agent_version       VARCHAR(32) NOT NULL DEFAULT 'repair_graph_v1',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repair_session_id, attempt_number)
);

CREATE INDEX idx_repair_attempts_session ON repair_attempts(repair_session_id);


CREATE TABLE repair_checkpoints (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repair_session_id       UUID        NOT NULL REFERENCES repair_sessions(id) ON DELETE CASCADE,
    attempt_number          INT         NOT NULL,
    modified_files          TEXT[]      NOT NULL DEFAULT '{}',
    created_files           TEXT[]      NOT NULL DEFAULT '{}',
    deleted_files           TEXT[]      NOT NULL DEFAULT '{}',
    -- Per-file unified diffs enabling deterministic rollback via reverse application.
    -- Schema: [{"file_path":"...", "diff_unified":"...", "lines_added":N, "lines_removed":N}]
    unified_diffs           JSONB       NOT NULL DEFAULT '[]',
    -- Reserved for Phase 6 copy-on-write snapshots — NULL today.
    container_snapshot_id   TEXT        NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repair_session_id, attempt_number)
);

CREATE INDEX idx_repair_checkpoints_session ON repair_checkpoints(repair_session_id);
