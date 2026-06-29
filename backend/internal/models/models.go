package models

import (
    "database/sql"
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