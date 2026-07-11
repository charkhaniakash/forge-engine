-- Migration 011: validation pipeline tables (Phase 8)
--
-- validation_runs: one row per validation attempt.
--   run_type = "baseline" captures pre-modification state (Phase 9 uses this).
--   run_type = "post_change" captures state after Phase 7 modifications.
--   baseline_run_id links a post_change run to its matching baseline.
--
-- validation_stages: one row per stage (install/build/test/lint/format).
--   sequence_number provides explicit ordering for Phase 11 replay —
--   never rely on timestamps for ordering.
--   combined_output stores stdout+stderr interleaved exactly as the developer
--   would see it in a terminal.
--
-- validation_diagnostics: one row per parsed error/warning.
--   Enriched with tool, origin, confidence, and symbol_name so Phase 9
--   retrieval can join directly against code_chunks(file_path, name).
--
-- Phase 9 consumes a single canonical ValidationRun domain object assembled
-- by ValidationRepository.GetRunWithFullResult — it never reads these tables
-- directly. Schema changes here do not break Phase 9.

CREATE TABLE validation_runs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_execution_id   UUID        NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
    workspace_id        UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- Stack detection results. All four fields set by StackDetector.
    stack               VARCHAR(32) NOT NULL,           -- "go" | "node" | "python"
    language            VARCHAR(32) NOT NULL,           -- "go" | "javascript" | "python"
    framework           VARCHAR(64) NOT NULL DEFAULT '', -- "react" | "nextjs" | "fastapi" | "standard" | ""
    package_manager     VARCHAR(32) NOT NULL DEFAULT '', -- "gomod" | "npm" | "yarn" | "pnpm" | "pip" | "uv"

    -- Validation profile selected from the registry.
    profile_id          VARCHAR(64) NOT NULL,           -- e.g. "go_default_v1"

    -- "baseline" = pre-modification; "post_change" = after Phase 7 edits.
    run_type            VARCHAR(16) NOT NULL DEFAULT 'post_change',

    -- Links a post_change run to its baseline for comparison.
    -- NULL means no baseline comparison available.
    baseline_run_id     UUID        NULL REFERENCES validation_runs(id),
    baseline_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Lifecycle
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- pending → running → passed | failed | error

    -- Canonical result consumed by Phase 9.
    -- passed | failed_repairable | failed_requires_human
    overall_result      VARCHAR(32) NULL,

    error               TEXT        NULL,
    started_at          TIMESTAMPTZ NULL,
    completed_at        TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_runs_task    ON validation_runs(task_execution_id);
CREATE INDEX idx_validation_runs_status  ON validation_runs(status)
    WHERE status NOT IN ('passed', 'failed', 'error');


CREATE TABLE validation_stages (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    validation_run_id   UUID        NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,

    -- Stage name: install | build | test | lint | format
    stage               VARCHAR(16) NOT NULL,

    -- Explicit ordering for Phase 11 replay. Never rely on timestamps.
    sequence_number     INT         NOT NULL,

    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    -- pending | running | passed | failed | skipped | error

    -- Command executed (argv array — never a shell string).
    command             TEXT[]      NULL,

    exit_code           INT         NULL,
    stdout              TEXT        NULL,
    stderr              TEXT        NULL,

    -- stdout + stderr interleaved exactly as shown in a terminal.
    combined_output     TEXT        NULL,

    duration_ms         INT         NULL,
    started_at          TIMESTAMPTZ NULL,
    completed_at        TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (validation_run_id, sequence_number)
);

CREATE INDEX idx_validation_stages_run ON validation_stages(validation_run_id, sequence_number);


CREATE TABLE validation_diagnostics (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    validation_run_id   UUID        NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,

    -- Which stage produced this diagnostic.
    stage               VARCHAR(16) NOT NULL,

    -- Severity: error | warning | info
    severity            VARCHAR(16) NOT NULL,

    -- Structured category for Phase 9 repair routing.
    -- compile_error | test_failure | lint_violation | runtime_panic |
    -- dependency_missing | format_violation | type_error | unknown
    category            VARCHAR(32) NOT NULL DEFAULT 'unknown',

    -- Source location
    file_path           TEXT        NULL,
    line_number         INT         NULL,
    column_number       INT         NULL,

    -- Symbol name at the error location (function, type, variable).
    -- Enables direct JOIN against code_chunks(file_path, name) in Phase 9.
    symbol_name         TEXT        NULL,

    message             TEXT        NOT NULL,
    raw_output          TEXT        NULL,     -- original line from stdout/stderr

    -- Provenance fields for Phase 9 confidence-weighted repair selection.
    tool                VARCHAR(64) NOT NULL DEFAULT 'unknown',
    -- go_compiler | go_test | eslint | pytest | ruff | generic_parser | ...
    origin              VARCHAR(8)  NOT NULL DEFAULT 'stderr',
    -- stdout | stderr
    confidence          REAL        NOT NULL DEFAULT 1.0,
    -- 1.0 = structured parser; 0.6 = regex; 0.3 = generic heuristic

    -- Set by the agent parser. auto_fixable | needs_human | unknown
    repair_category     VARCHAR(32) NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_validation_diagnostics_run      ON validation_diagnostics(validation_run_id);
CREATE INDEX idx_validation_diagnostics_severity ON validation_diagnostics(validation_run_id, severity);
CREATE INDEX idx_validation_diagnostics_file     ON validation_diagnostics(validation_run_id, file_path)
    WHERE file_path IS NOT NULL;
