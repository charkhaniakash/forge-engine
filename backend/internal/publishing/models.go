package publishing

import "time"

// PublishingSession tracks the progress of a single publishing attempt.
type PublishingSession struct {
	ID                string     `json:"id"`
	WorkItemID        string     `json:"work_item_id"`
	TaskExecutionID   string     `json:"task_execution_id"`
	WorkspaceID       string     `json:"workspace_id"`
	Status            string     `json:"status"`
	CurrentStep       *string    `json:"current_step,omitempty"`
	BranchName        *string    `json:"branch_name,omitempty"`
	PRNumber          *int       `json:"pr_number,omitempty"`
	PRURL             *string    `json:"pr_url,omitempty"`
	DraftMode         bool       `json:"draft_mode"`
	ErrorMessage      *string    `json:"error_message,omitempty"`
	CancelReason      *string    `json:"cancellation_reason,omitempty"`
	InitiatedBy       *string    `json:"initiated_by,omitempty"`
	StartedAt         *time.Time `json:"started_at,omitempty"`
	CompletedAt       *time.Time `json:"completed_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// GitBranch represents a feature branch created by the publishing pipeline.
type GitBranch struct {
	ID            string    `json:"id"`
	WorkItemID    string    `json:"work_item_id"`
	SessionID     string    `json:"session_id"`
	BranchName    string    `json:"branch_name"`
	BaseCommitSHA string    `json:"base_commit_sha"`
	HeadCommitSHA *string   `json:"head_commit_sha,omitempty"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// GitCommit represents a commit created by the publishing pipeline.
type GitCommit struct {
	ID           string    `json:"id"`
	BranchID     string    `json:"branch_id"`
	SessionID    string    `json:"session_id"`
	CommitSHA    string    `json:"commit_sha"`
	Message      string    `json:"message"`
	AuthorName   string    `json:"author_name"`
	AuthorEmail  string    `json:"author_email"`
	ExecutionID  *string   `json:"execution_id,omitempty"`
	CommitOrder  int       `json:"commit_order"`
	CreatedAt    time.Time `json:"created_at"`
}

// PullRequest represents a PR created via the GitHub App.
type PullRequest struct {
	ID           string    `json:"id"`
	WorkItemID   string    `json:"work_item_id"`
	BranchID     string    `json:"branch_id"`
	SessionID    string    `json:"session_id"`
	PRNumber     int       `json:"pr_number"`
	GitHubPRID   *int64    `json:"github_pr_id,omitempty"`
	URL          string    `json:"url"`
	Title        string    `json:"title"`
	State        string    `json:"state"`
	Draft        bool      `json:"draft"`
	ReviewState  *string   `json:"review_state,omitempty"`
	Mergeable    *bool     `json:"mergeable,omitempty"`
	HeadSHA      *string   `json:"head_sha,omitempty"`
	BaseBranch   string    `json:"base_branch"`
	Additions    *int      `json:"additions,omitempty"`
	Deletions    *int      `json:"deletions,omitempty"`
	ChangedFiles *int      `json:"changed_files,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// PublishRequest is the input to start a publishing workflow.
type PublishRequest struct {
	WorkItemID      string `json:"work_item_id"`
	TaskExecutionID string `json:"task_execution_id"`
	WorkspaceID     string `json:"workspace_id"`
	RepoFullName    string `json:"repo_full_name"`
	DefaultBranch   string `json:"default_branch"`
	BaseCommitSHA   string `json:"base_commit_sha"`
	DraftMode       bool   `json:"draft_mode"`
	UserID          string `json:"user_id"`
	TraceID         string `json:"trace_id"`
}

// SummaryRequest is sent to the Agent for commit message / PR description generation.
type SummaryRequest struct {
	WorkItemID       string                `json:"work_item_id"`
	TaskExecutionID  string                `json:"task_execution_id"`
	Intent           string                `json:"intent"`
	PlanSummary      string                `json:"plan_summary"`
	Steps            []PlanStepSummary     `json:"steps"`
	Diffs            []DiffSummary         `json:"diffs"`
	ValidationResult *string               `json:"validation_result,omitempty"`
	RepairHistory    []RepairAttemptBrief  `json:"repair_history,omitempty"`
	RequestType      string                `json:"request_type"` // "commit_message" | "pr_description"
	RequestID        string                `json:"request_id"`
}

// PlanStepSummary is a lightweight representation of a plan step for summarization.
type PlanStepSummary struct {
	Title         string   `json:"title"`
	Description   string   `json:"description,omitempty"`
	AffectedFiles []string `json:"affected_files,omitempty"`
}

// RepairAttemptBrief is a lightweight summary of a repair attempt for PR descriptions.
type RepairAttemptBrief struct {
	AttemptNumber int    `json:"attempt_number"`
	Strategy      string `json:"strategy,omitempty"`
	Outcome       string `json:"outcome"`
}

// DiffSummary is a simplified diff representation for the Agent.
type DiffSummary struct {
	FilePath  string `json:"file_path"`
	Operation string `json:"operation"` // create | modify | delete | rename
	Added     int    `json:"lines_added"`
	Removed   int    `json:"lines_removed"`
}

// SummaryResponse is returned from the Agent summary endpoint.
type SummaryResponse struct {
	CommitSubject string `json:"commit_subject,omitempty"`
	CommitBody    string `json:"commit_body,omitempty"`
	PRTitle       string `json:"pr_title,omitempty"`
	PRBody        string `json:"pr_body,omitempty"`
}

// ProgressEvent is a WebSocket event streamed to the frontend.
type ProgressEvent struct {
	Version   int    `json:"v"`
	Event     string `json:"event"`
	SessionID string `json:"session_id"`
	Step      string `json:"step,omitempty"`
	Status    string `json:"status,omitempty"` // started | completed | failed
	Message   string `json:"message,omitempty"`
	PRURL     string `json:"pr_url,omitempty"`
	PRNumber  int    `json:"pr_number,omitempty"`
	Timestamp int64  `json:"ts"`
}

// Publishing steps (ordered)
const (
	StepVerify       = "workspace_verification"
	StepBranch       = "branch_creation"
	StepCommit       = "commit_creation"
	StepConflictCheck = "conflict_check"
	StepPush         = "branch_push"
	StepCreatePR     = "pr_creation"
	StepSync         = "github_sync"
	StepComplete     = "publishing_complete"
)

// Session statuses
const (
	StatusPending      = "pending"
	StatusVerifying    = "verifying"
	StatusBranching    = "branching"
	StatusCommitting   = "committing"
	StatusConflictCheck = "conflict_check"
	StatusPushing      = "pushing"
	StatusCreatingPR   = "creating_pr"
	StatusSyncing      = "syncing"
	StatusCompleted    = "completed"
	StatusFailed       = "failed"
	StatusCancelled    = "cancelled"
)

// Buffer and channel capacity constants.
const (
	// WSChannelBufferSize is the capacity of per-subscriber WebSocket send channels.
	WSChannelBufferSize = 256

	// EventReplayBufferMax is the maximum number of events buffered for late-connecting subscribers.
	EventReplayBufferMax = 200

	// EventReplayCleanupDelay is how long after a terminal event before the replay buffer is freed.
	EventReplayCleanupDelay = 2 * time.Minute

	// PushMaxRetries is the maximum number of push retry attempts.
	PushMaxRetries = 3
)
