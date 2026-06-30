-- Migration 008: work_items + plans (Phase 5)
--
-- work_items: the central unit of autonomous engineering work.
--   Phase 5 only uses type='task'. parent_id and template_id are NULL
--   in Phase 5 and reserved for future composition (sub-tasks, templates).
--
-- plans: immutable, append-only plan versions.
--   Every re-plan creates a new version row. The active plan is always
--   the highest version with is_active=true for a given work_item_id.
--   Plans are the central contract between planning, execution, PR generation,
--   and every future execution phase.
--
-- Approval gate: Go enforces that status cannot advance past 'plan_approved'
--   without approval_status IN ('approved', 'auto_approved').
--   Phase 5 only implements 'always_require_human' policy.

CREATE TABLE work_items (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id          UUID        NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
    org_id           UUID        NOT NULL,
    user_id          UUID        NOT NULL,

    -- Composition (Phase 5: always NULL)
    parent_id        UUID        NULL REFERENCES work_items(id) ON DELETE CASCADE,
    template_id      UUID        NULL,

    -- Type: extensible enum. Phase 5 only uses 'task'.
    type             VARCHAR(32) NOT NULL DEFAULT 'task',

    -- The user's raw natural-language intent.
    intent           TEXT        NOT NULL,

    -- Lifecycle state machine (owned entirely by Go).
    -- Transitions: draft → planning → [planning_failed] → plan_ready
    --              → plan_approved → executing → done | failed | cancelled
    status           VARCHAR(32) NOT NULL DEFAULT 'draft',

    -- Approval gate.
    -- Phase 5: always starts as 'pending_review', transitions to 'approved'
    --          via explicit user action. policy_type='always_require_human'.
    approval_status  VARCHAR(32) NOT NULL DEFAULT 'pending_review',

    -- JSONB approval policy evaluated by Go at each approval transition.
    -- Phase 5 default: {"type": "always_require_human"}
    -- Phase 12+: {"type": "auto_approve_if", "conditions": [...]}
    approval_policy  JSONB       NOT NULL DEFAULT '{"type":"always_require_human"}',

    -- Set when status transitions to planning_failed or failed.
    error            TEXT        NULL,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_work_items_repo_id   ON work_items(repo_id);
CREATE INDEX idx_work_items_org_user  ON work_items(org_id, user_id);
CREATE INDEX idx_work_items_status    ON work_items(repo_id, status);
-- Support future parent/sub-task queries
CREATE INDEX idx_work_items_parent_id ON work_items(parent_id) WHERE parent_id IS NOT NULL;


CREATE TABLE plans (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id     UUID        NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,

    -- Monotonically incrementing per work_item. Version 1 = first agent-generated plan.
    version          INT         NOT NULL DEFAULT 1,

    -- Schema version for the plan body JSONB. Validated on write and read.
    schema_version   VARCHAR(16) NOT NULL DEFAULT 'v1',

    -- Planner type: matches a registered planner in the PlannerRegistry.
    -- Phase 5: always 'implementation'.
    plan_type        VARCHAR(32) NOT NULL DEFAULT 'implementation',

    -- Identifies the exact planner implementation that produced this plan.
    -- Useful for replay, debugging, and A/B comparison.
    planner_id       VARCHAR(128) NOT NULL DEFAULT 'implementation_planner_v1',

    -- Full PlanSchema v1 object — the central execution contract.
    -- Steps, risks, assumptions, affected_files all live here.
    body             JSONB       NOT NULL,

    -- Only one plan version is active at a time. Superseded by re-plans.
    is_active        BOOLEAN     NOT NULL DEFAULT TRUE,

    -- Who created this version: 'agent' or 'user_edit'.
    created_by       VARCHAR(32) NOT NULL DEFAULT 'agent',

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Immutability: (work_item_id, version) is a unique snapshot key.
    UNIQUE (work_item_id, version)
);

CREATE INDEX idx_plans_work_item_id ON plans(work_item_id);
CREATE INDEX idx_plans_active       ON plans(work_item_id, is_active) WHERE is_active = TRUE;
