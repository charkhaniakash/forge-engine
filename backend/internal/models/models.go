package models

import (
    "database/sql"
    "encoding/json"
    "time"
)

// User represents a system user
type User struct {
    ID           string    `json:"id"`
    Email        string    `json:"email"`
    PasswordHash string    `json:"-"` // Never expose
    Name         string    `json:"name"`
    CreatedAt    time.Time `json:"created_at"`
    UpdatedAt    time.Time `json:"updated_at"`
}

// Organization represents a user organization
type Organization struct {
    ID        string    `json:"id"`
    Name      string    `json:"name"`
    OwnerID   string    `json:"owner_id"`
    CreatedAt time.Time `json:"created_at"`
    UpdatedAt time.Time `json:"updated_at"`
}

// OrganizationMember represents a user's membership in an org
type OrganizationMember struct {
    ID        string    `json:"id"`
    OrgID     string    `json:"org_id"`
    UserID    string    `json:"user_id"`
    Role      string    `json:"role"` // owner, admin, member
    CreatedAt time.Time `json:"created_at"`
    UpdatedAt time.Time `json:"updated_at"`
}

// Invitation represents a pending org invitation
type Invitation struct {
    ID        string       `json:"id"`
    OrgID     string       `json:"org_id"`
    Email     string       `json:"email"`
    Role      string       `json:"role"`
    Token     string       `json:"token"`
    ExpiresAt time.Time    `json:"expires_at"`
    AcceptedAt sql.NullTime `json:"accepted_at"`
    CreatedAt time.Time    `json:"created_at"`
}

// Claims represents JWT claims for a user
type Claims struct {
    UserID string `json:"user_id"`
    Email  string `json:"email"`
    OrgID  string `json:"org_id"` // Current org context
    Role   string `json:"role"`   // Current org role
}

// GitHubInstallation represents a GitHub App installation for an org
type GitHubInstallation struct {
    ID                  string     `json:"id"`
    OrgID               string     `json:"org_id"`
    GitHubInstallationID int64     `json:"github_installation_id"`
    GitHubAccountID     int64      `json:"github_account_id"`
    GitHubAccountLogin  string     `json:"github_account_login"`
    AccessToken         string     `json:"-"` // Never expose
    TokenExpiresAt      *time.Time `json:"token_expires_at,omitempty"`
    CreatedAt           time.Time  `json:"created_at"`
    UpdatedAt           time.Time  `json:"updated_at"`
}

// GitHubRepo represents a GitHub repository accessible via an installation
type GitHubRepo struct {
    ID              string     `json:"id"`
    InstallationID   string     `json:"installation_id"`
    GitHubRepoID    int64      `json:"github_repo_id"`
    RepoName        string     `json:"repo_name"`
    RepoFullName    string     `json:"repo_full_name"`
    RepoOwner       string     `json:"repo_owner"`
    DefaultBranch   string     `json:"default_branch"`
    Private         bool       `json:"private"`
    LastSyncedAt    *time.Time `json:"last_synced_at,omitempty"`
    LastCommitSHA   *string `json:"last_commit_sha,omitempty"`
    CreatedAt       time.Time  `json:"created_at"`
    UpdatedAt       time.Time  `json:"updated_at"`
}

// PendingInstall represents a pending GitHub App installation awaiting webhook confirmation
type PendingInstall struct {
    ID         string    `json:"id"`
    OrgID      string    `json:"org_id"`
    StateToken string    `json:"state_token"`
    CSRFToken  string    `json:"csrf_token"`
    CreatedAt  time.Time `json:"created_at"`
    ExpiresAt  time.Time `json:"expires_at"`
}

// QASession represents a multi-turn Q&A conversation scoped to a single
// (repo_id, commit_sha) snapshot. The snapshot is pinned at session creation;
// subsequent questions in the session always retrieve against the same commit.
// workspace_id is NULL in Phase 4 and will be populated by a later phase.
type QASession struct {
    ID          string     `json:"id"`
    RepoID      string     `json:"repo_id"`
    OrgID       string     `json:"org_id"`
    UserID      string     `json:"user_id"`
    CommitSHA   string     `json:"commit_sha"`
    Title       *string    `json:"title,omitempty"`
    WorkspaceID *string    `json:"workspace_id,omitempty"` // Phase 5+
    CreatedAt   time.Time  `json:"created_at"`
    UpdatedAt   time.Time  `json:"updated_at"`
}

// QAMessage is a single turn in a QASession.
// role is "user" or "assistant".
// Citations is a JSONB array of rich citation objects — populated for
// assistant messages only, NULL for user messages.
type QAMessage struct {
    ID         string      `json:"id"`
    SessionID  string      `json:"session_id"`
    Role       string      `json:"role"` // user | assistant
    Content    string      `json:"content"`
    Citations  interface{} `json:"citations,omitempty"` // []Citation JSONB
    TokenCount *int        `json:"token_count,omitempty"`
    Model      *string     `json:"model,omitempty"`
    RequestID  *string     `json:"request_id,omitempty"`
    CreatedAt  time.Time   `json:"created_at"`
}

// WorkItem is the central unit of engineering work in the autonomous platform.
// It represents a user's intent that flows through planning, approval, and execution.
//
// Phase 5 only populates type='task'. parent_id and template_id are reserved
// for future sub-task composition and task templates.
//
// Ownership rules:
//   - Go owns all status transitions. The Agent never writes to work_items.
//   - The approval gate is enforced by Go: status cannot advance past
//     'plan_approved' without approval_status IN ('approved', 'auto_approved').
type WorkItem struct {
	ID             string          `json:"id"`
	RepoID         string          `json:"repo_id"`
	OrgID          string          `json:"org_id"`
	UserID         string          `json:"user_id"`
	ParentID       *string         `json:"parent_id,omitempty"`   // Phase 5: always nil
	TemplateID     *string         `json:"template_id,omitempty"` // Phase 5: always nil
	Type           string          `json:"type"`                  // "task" in Phase 5
	Intent         string          `json:"intent"`                // raw user input
	Status         string          `json:"status"`                // see state machine below
	ApprovalStatus string          `json:"approval_status"`       // pending_review|approved|auto_approved|blocked|changes_requested
	ApprovalPolicy json.RawMessage `json:"approval_policy"`       // {"type":"always_require_human"} in Phase 5
	Error          *string         `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

// WorkItemStatuses enumerates the valid work_items.status values.
// Transitions are enforced by WorkItemRepository methods — no direct SQL updates.
const (
	WorkItemStatusDraft          = "draft"
	WorkItemStatusPlanning       = "planning"
	WorkItemStatusPlanningFailed = "planning_failed"
	WorkItemStatusPlanReady      = "plan_ready"
	WorkItemStatusPlanApproved   = "plan_approved"
	WorkItemStatusExecuting      = "executing" // Phase 7+
	WorkItemStatusRepairing      = "repairing" // Phase 9+
	WorkItemStatusDone           = "done"
	WorkItemStatusNoChanges      = "no_changes" // execution made zero file changes — honest terminal state, NOT a success
	WorkItemStatusFailed         = "failed"
	WorkItemStatusCancelled      = "cancelled"
)

// Plan is an immutable, versioned implementation plan for a WorkItem.
// Plans are append-only: each re-plan creates a new version row.
// The body field contains the full PlanSchema v1 object — the central
// execution contract consumed by every phase from 5 onward.
//
// See docs/schemas/plan_v1.json for the canonical schema definition.
type Plan struct {
	ID           string          `json:"id"`
	WorkItemID   string          `json:"work_item_id"`
	Version      int             `json:"version"`
	SchemaVersion string         `json:"schema_version"` // "v1"
	PlanType     string          `json:"plan_type"`      // "implementation"
	PlannerID    string          `json:"planner_id"`     // "implementation_planner_v1"
	Body         json.RawMessage `json:"body"`           // full PlanSchema v1
	IsActive     bool            `json:"is_active"`
	CreatedBy    string          `json:"created_by"` // "agent" | "user_edit"
	CreatedAt    time.Time       `json:"created_at"`
}

// Workspace is the domain-level execution environment for one task execution attempt.
// It owns the full lifecycle from provisioning through destruction.
//
// Terminology:
//   Workspace   — the platform concept (what handlers and the frontend see)
//   Sandbox     — the runtime instance managed by a SandboxDriver
//   Container   — the Docker implementation detail (container_id is opaque)
//
// Ownership: Go owns every status transition. The Agent never writes to workspaces.
// Approval gate: a workspace can only be provisioned when the associated
// work_item.approval_status IN ('approved', 'auto_approved').
type Workspace struct {
	ID             string     `json:"id"`
	WorkItemID     string     `json:"work_item_id"`
	RepoID         string     `json:"repo_id"`
	CommitSHA      string     `json:"commit_sha"`
	Driver         string     `json:"driver"`          // "docker"
	ContainerID    *string    `json:"-"`               // never exposed in API responses
	ContainerName  *string    `json:"container_name,omitempty"`
	Image          string     `json:"image"`
	CPULimit       string     `json:"cpu_limit"`
	MemoryLimitMB  int        `json:"memory_limit_mb"`
	PIDLimit       int        `json:"pid_limit"`
	TimeoutSeconds int        `json:"timeout_seconds"`
	Status         string     `json:"status"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	ReadyAt        *time.Time `json:"ready_at,omitempty"`
	DestroyedAt    *time.Time `json:"destroyed_at,omitempty"`
	Error          *string    `json:"error,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// Workspace status constants.
const (
	WorkspaceStatusProvisioning = "provisioning"
	WorkspaceStatusReady        = "ready"
	WorkspaceStatusExecuting    = "executing"
	WorkspaceStatusCompleted    = "completed"
	WorkspaceStatusFailed       = "failed"
	WorkspaceStatusTimedOut     = "timed_out"
	WorkspaceStatusKilled       = "killed"
	WorkspaceStatusDestroying   = "destroying"
	WorkspaceStatusDestroyed    = "destroyed"
)

// ExecutionLog records every event in a workspace's lifetime:
//   - Lifecycle transitions (workspace_creating, repo_cloning, workspace_ready, …)
//   - Commands executed via ExecutionService (command events)
//
// The seq field provides ordered replay and powers the live worklog UI.
type ExecutionLog struct {
	ID             string     `json:"id"`
	WorkspaceID    string     `json:"workspace_id"`
	Seq            int        `json:"seq"`
	EventType      string     `json:"event_type"`      // "lifecycle" | "command"
	LifecycleEvent *string    `json:"lifecycle_event,omitempty"`
	Command        []string   `json:"command,omitempty"`
	WorkingDir     *string    `json:"working_dir,omitempty"`
	ExitCode       *int       `json:"exit_code,omitempty"`
	TimedOut       bool       `json:"timed_out"`
	TimeoutSeconds *int       `json:"timeout_seconds,omitempty"`
	DurationMS     *int       `json:"duration_ms,omitempty"`
	Stdout         *string    `json:"stdout,omitempty"`
	Stderr         *string    `json:"stderr,omitempty"`
	Message        *string    `json:"message,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

// Lifecycle event name constants.
const (
	LifecycleEventCreating        = "workspace_creating"
	LifecycleEventCreated         = "workspace_created"
	LifecycleEventRepoCloning     = "repo_cloning"
	LifecycleEventRepoCloned      = "repo_cloned"
	LifecycleEventRepoCheckout    = "repo_checkout"
	LifecycleEventReady           = "workspace_ready"
	LifecycleEventDestroying      = "workspace_destroying"
	LifecycleEventDestroyed       = "workspace_destroyed"
	LifecycleEventFailed          = "workspace_failed"
)

// ── Phase 7 — Execution models ────────────────────────────────────────────────

// ExecutionContext carries all identity and configuration for one execution.
// Go resolves and injects this at execution start; the agent receives it
// in every step request and must never override it.
type ExecutionContext struct {
	TaskExecutionID  string `json:"task_execution_id"`
	StepExecutionID  string `json:"step_execution_id,omitempty"` // current step execution ID
	WorkspaceID      string `json:"workspace_id"`
	StepID           string `json:"step_id,omitempty"` // current step stable_id
	PlanVersion      int    `json:"plan_version"`
	TraceID          string `json:"trace_id"`
	OrgID            string `json:"org_id"`
	UserID           string `json:"user_id"`
	// LLM configuration — resolved from org policy at execution start.
	Model         string  `json:"model"`
	Temperature   float64 `json:"temperature"`
	MaxTokens     int     `json:"max_tokens"`
	ExecutionMode string  `json:"execution_mode"`  // "autonomous" | "supervised"
	AutonomyLevel string  `json:"autonomy_level"`  // "full" | "step_approval" | "tool_approval"
}

// TaskExecution is one attempt to execute a work item's approved plan.
// Go owns every status transition. The agent never writes to this table.
type TaskExecution struct {
	ID                   string          `json:"id"`
	WorkItemID           string          `json:"work_item_id"`
	WorkspaceID          string          `json:"workspace_id"`
	PlanID               string          `json:"plan_id"`
	Status               string          `json:"status"` // pending|running|completed|failed|cancelled|paused
	CurrentStepStableID  *string         `json:"current_step_stable_id,omitempty"`
	ExecutionContext      json.RawMessage `json:"execution_context"`
	StartedAt            *time.Time      `json:"started_at,omitempty"`
	CompletedAt          *time.Time      `json:"completed_at,omitempty"`
	Error                *string         `json:"error,omitempty"`
	CreatedAt            time.Time       `json:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"`
}

// StepExecution tracks the execution of one plan step.
type StepExecution struct {
	ID              string     `json:"id"`
	TaskExecutionID string     `json:"task_execution_id"`
	StepStableID    string     `json:"step_stable_id"`
	StepOrder       int        `json:"step_order"`
	Status          string     `json:"status"` // pending|running|completed|failed|skipped|deviated
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	Reasoning       *string    `json:"reasoning,omitempty"`
	DeviationNote   *string    `json:"deviation_note,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// ExecutionEvent is one entry in the ordered event log for an execution.
// Covers tool calls, reasoning notes, deviations, and lifecycle transitions.
type ExecutionEvent struct {
	ID              string          `json:"id"`
	TaskExecutionID string          `json:"task_execution_id"`
	StepExecutionID *string         `json:"step_execution_id,omitempty"`
	Seq             int             `json:"seq"`
	EventType       string          `json:"event_type"`
	ToolName        *string         `json:"tool_name,omitempty"`
	ToolArgs        json.RawMessage `json:"tool_args,omitempty"`
	ToolResult      json.RawMessage `json:"tool_result,omitempty"`
	ToolCallID      *string         `json:"tool_call_id,omitempty"` // idempotency key
	Message         *string         `json:"message,omitempty"`
	Success         *bool           `json:"success,omitempty"`
	DurationMS      *int            `json:"duration_ms,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
}

// CodeDiff is a structured diff computed by Go for one file modification.
// The agent sends the new file content; Go reads the old content and diffs.
type CodeDiff struct {
	ID              string    `json:"id"`
	TaskExecutionID string    `json:"task_execution_id"`
	StepExecutionID string    `json:"step_execution_id"`
	FilePath        string    `json:"file_path"`
	Operation       string    `json:"operation"` // modify|create|delete|rename
	OldPath         *string   `json:"old_path,omitempty"`
	DiffUnified     *string   `json:"diff_unified,omitempty"`
	LinesAdded      int       `json:"lines_added"`
	LinesRemoved    int       `json:"lines_removed"`
	CreatedAt       time.Time `json:"created_at"`
}

// ExecutionCheckpoint is persisted after every completed step.
// Phase 12 reads the latest checkpoint to resume from the correct position.
type ExecutionCheckpoint struct {
	ID              string    `json:"id"`
	TaskExecutionID string    `json:"task_execution_id"`
	StepStableID    string    `json:"step_stable_id"`
	StepOrder       int       `json:"step_order"`
	ModifiedFiles   []string  `json:"modified_files"`
	CreatedFiles    []string  `json:"created_files"`
	DeletedFiles    []string  `json:"deleted_files"`
	CreatedAt       time.Time `json:"created_at"`
}

// ── Phase 8 — Validation models ──────────────────────────────────────────────

// ValidationRun is the canonical domain object consumed by Phase 9.
// It is assembled by ValidationRepository.GetRunWithFullResult and
// provides a single interface over the three validation tables.
// Phase 9 never reads validation_runs, validation_stages, or
// validation_diagnostics directly — it only calls GetRunWithFullResult.
type ValidationRun struct {
	ID               string               `json:"id"`
	TaskExecutionID  string               `json:"task_execution_id"`
	WorkspaceID      string               `json:"workspace_id"`
	Stack            string               `json:"stack"`
	Language         string               `json:"language"`
	Framework        string               `json:"framework"`
	PackageManager   string               `json:"package_manager"`
	ProfileID        string               `json:"profile_id"`
	RunType          string               `json:"run_type"`   // "baseline" | "post_change"
	BaselineRunID    *string              `json:"baseline_run_id,omitempty"`
	BaselineEnabled  bool                 `json:"baseline_enabled"`
	Status           string               `json:"status"`     // pending|running|passed|failed|error
	OverallResult    *string              `json:"overall_result,omitempty"` // passed|failed_repairable|failed_requires_human
	Error            *string              `json:"error,omitempty"`
	StartedAt        *time.Time           `json:"started_at,omitempty"`
	CompletedAt      *time.Time           `json:"completed_at,omitempty"`
	CreatedAt        time.Time            `json:"created_at"`
	UpdatedAt        time.Time            `json:"updated_at"`

	// Populated by GetRunWithFullResult
	Stages      []*ValidationStage      `json:"stages,omitempty"`
	Diagnostics []*ValidationDiagnostic `json:"diagnostics,omitempty"`
	Summary     *ValidationSummary      `json:"summary,omitempty"`
	Baseline    *ValidationRun          `json:"baseline,omitempty"` // linked baseline run
}

// ValidationStage is one stage within a validation run.
type ValidationStage struct {
	ID              string     `json:"id"`
	ValidationRunID string     `json:"validation_run_id"`
	Stage           string     `json:"stage"`          // install|build|test|lint|format
	SequenceNumber  int        `json:"sequence_number"` // explicit ordering for Phase 11 replay
	Status          string     `json:"status"`
	Command         []string   `json:"command,omitempty"`
	ExitCode        *int       `json:"exit_code,omitempty"`
	Stdout          *string    `json:"stdout,omitempty"`
	Stderr          *string    `json:"stderr,omitempty"`
	CombinedOutput  *string    `json:"combined_output,omitempty"`
	DurationMS      *int       `json:"duration_ms,omitempty"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

// ValidationDiagnostic is one parsed error or warning from a validation stage.
type ValidationDiagnostic struct {
	ID              string  `json:"id"`
	ValidationRunID string  `json:"validation_run_id"`
	Stage           string  `json:"stage"`
	Severity        string  `json:"severity"`        // error|warning|info
	Category        string  `json:"category"`        // compile_error|test_failure|...
	FilePath        *string `json:"file_path,omitempty"`
	LineNumber      *int    `json:"line_number,omitempty"`
	ColumnNumber    *int    `json:"column_number,omitempty"`
	SymbolName      *string `json:"symbol_name,omitempty"`
	Message         string  `json:"message"`
	RawOutput       *string `json:"raw_output,omitempty"`
	Tool            string  `json:"tool"`           // go_compiler|go_test|eslint|...
	Origin          string  `json:"origin"`         // stdout|stderr
	Confidence      float32 `json:"confidence"`     // 1.0=structured; 0.5=regex; 0.3=generic
	RepairCategory  *string `json:"repair_category,omitempty"` // auto_fixable|needs_human|unknown
	CreatedAt       time.Time `json:"created_at"`
}

// ValidationSummary is a pre-computed summary for fast Phase 9 routing.
type ValidationSummary struct {
	TotalErrors       int  `json:"total_errors"`
	TotalWarnings     int  `json:"total_warnings"`
	BuildPassed       bool `json:"build_passed"`
	TestsPassed       bool `json:"tests_passed"`
	LintPassed        bool `json:"lint_passed"`
	AutoFixableCount  int  `json:"auto_fixable_count"`
	NeedsHumanCount   int  `json:"needs_human_count"`
}

// IngestionJob represents one attempt to index a repository at a specific commit SHA.
// The (repo_id, commit_sha) pair is the logical snapshot key.
// Retrieval (Phase 4+) must only read code_chunks where the associated job has
// status = "done".
type IngestionJob struct {
    ID              string     `json:"id"`
    RepoID          string     `json:"repo_id"`
    CommitSHA       string     `json:"commit_sha"`
    TriggerType     string     `json:"trigger_type"` // installation_sync | push | manual
    Status          string     `json:"status"`        // queued | running | done | failed | superseded
    ProgressStage   *string    `json:"progress_stage,omitempty"` // cloning | parsing | chunking | embedding | persisting | completed
    QueuedAt        time.Time  `json:"queued_at"`
    StartedAt       *time.Time `json:"started_at,omitempty"`
    FinishedAt      *time.Time `json:"finished_at,omitempty"`
    WorkerID        *string    `json:"worker_id,omitempty"`
    TotalChunks     *int       `json:"total_chunks,omitempty"`
    ProcessedChunks int        `json:"processed_chunks"`
    Error           *string    `json:"error,omitempty"`
    CreatedAt       time.Time  `json:"created_at"`
    UpdatedAt       time.Time  `json:"updated_at"`
}

// ── Phase 9 — Repair models ───────────────────────────────────────────────────

// RepairSession tracks one autonomous repair loop for a task.
type RepairSession struct {
	ID                       string     `json:"id"`
	TaskExecutionID          string     `json:"task_execution_id"`
	WorkspaceID              string     `json:"workspace_id"`
	TriggerValidationRunID   string     `json:"trigger_validation_run_id"`
	MaxAttempts              int        `json:"max_attempts"`
	AttemptsUsed             int        `json:"attempts_used"`
	MaxDurationSecs          int        `json:"max_duration_secs"`
	Status                   string     `json:"status"` // running|completed|exhausted|escalated|cancelled
	FinalValidationRunID     *string    `json:"final_validation_run_id,omitempty"`
	EscalationReason         *string    `json:"escalation_reason,omitempty"`
	StartedAt                time.Time  `json:"started_at"`
	CompletedAt              *time.Time `json:"completed_at,omitempty"`
	CreatedAt                time.Time  `json:"created_at"`
}

// RepairAttempt is one RepairGraph invocation within a session.
type RepairAttempt struct {
	ID               string          `json:"id"`
	RepairSessionID  string          `json:"repair_session_id"`
	AttemptNumber    int             `json:"attempt_number"`
	DiagnosticsInput json.RawMessage `json:"diagnostics_input"`
	Reasoning        json.RawMessage `json:"reasoning,omitempty"`
	Strategy         *string         `json:"strategy,omitempty"`
	Confidence       *float64        `json:"confidence,omitempty"`
	ModifiedFiles    []string        `json:"modified_files"`
	ValidationRunID  *string         `json:"validation_run_id,omitempty"`
	Outcome          *string         `json:"outcome,omitempty"` // improved|no_change|regressed|error
	AgentVersion     string          `json:"agent_version"`
	StartedAt        time.Time       `json:"started_at"`
	CompletedAt      *time.Time      `json:"completed_at,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
}

// RepairCheckpoint is a workspace snapshot after each repair attempt.
type RepairCheckpoint struct {
	ID                   string          `json:"id"`
	RepairSessionID      string          `json:"repair_session_id"`
	AttemptNumber        int             `json:"attempt_number"`
	ModifiedFiles        []string        `json:"modified_files"`
	CreatedFiles         []string        `json:"created_files"`
	DeletedFiles         []string        `json:"deleted_files"`
	UnifiedDiffs         json.RawMessage `json:"unified_diffs"` // [{file_path, diff_unified, lines_added, lines_removed}]
	ContainerSnapshotID  *string         `json:"container_snapshot_id,omitempty"`
	CreatedAt            time.Time       `json:"created_at"`
}

// RepairDiff is one entry in a RepairCheckpoint.UnifiedDiffs array.
type RepairDiff struct {
	FilePath     string `json:"file_path"`
	DiffUnified  string `json:"diff_unified"`
	LinesAdded   int    `json:"lines_added"`
	LinesRemoved int    `json:"lines_removed"`
}

// ── Phase 16 — Mission follow-up history ──────────────────────────────────────

// MissionMessage is a single message in a mission's follow-up chat thread.
// role is "user" or "assistant". turn_number groups messages by conversation turn
// (1 = original intent, 2 = first follow-up, etc.).
type MissionMessage struct {
	ID         string    `json:"id"`
	WorkItemID string    `json:"work_item_id"`
	Role       string    `json:"role"`        // "user" | "assistant"
	Content    string    `json:"content"`
	TurnNumber int       `json:"turn_number"`
	CreatedAt  time.Time `json:"created_at"`
}
