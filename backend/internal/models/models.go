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