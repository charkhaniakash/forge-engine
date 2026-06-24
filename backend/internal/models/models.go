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