package repository

import (
    "context"
    "database/sql"
    "errors"
    "time"

    "github.com/charkhaniakash/forge-engine/backend/internal/models"
)

type InvitationRepository struct {
    db *sql.DB
}

func NewInvitationRepository(db *sql.DB) *InvitationRepository {
    return &InvitationRepository{db: db}
}

// CreateInvitation creates a new invitation
func (r *InvitationRepository) CreateInvitation(ctx context.Context, orgID, email, token, role string, expiresAt time.Time) (*models.Invitation, error) {
    inv := &models.Invitation{
        OrgID:     orgID,
        Email:     email,
        Token:     token,
        Role:      role,
        ExpiresAt: expiresAt,
    }

    err := r.db.QueryRowContext(
        ctx,
        `INSERT INTO invitations (org_id, email, role, token, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        orgID, email, role, token, expiresAt,
    ).Scan(&inv.ID, &inv.CreatedAt)

    return inv, err
}

// GetInvitationByToken retrieves an invitation by token
func (r *InvitationRepository) GetInvitationByToken(ctx context.Context, token string) (*models.Invitation, error) {
    inv := &models.Invitation{}
    err := r.db.QueryRowContext(
        ctx,
        `SELECT id, org_id, email, role, token, expires_at, accepted_at, created_at FROM invitations WHERE token = $1`,
        token,
    ).Scan(&inv.ID, &inv.OrgID, &inv.Email, &inv.Role, &inv.Token, &inv.ExpiresAt, &inv.AcceptedAt, &inv.CreatedAt)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, errors.New("invitation not found")
        }
        return nil, err
    }

    return inv, nil
}

// AcceptInvitation marks an invitation as accepted and adds user to org
func (r *InvitationRepository) AcceptInvitation(ctx context.Context, invID, userID string) error {
    tx, err := r.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Get invitation details
    var orgID, role string
    err = tx.QueryRowContext(
        ctx,
        `SELECT org_id, role FROM invitations WHERE id = $1`,
        invID,
    ).Scan(&orgID, &role)
    if err != nil {
        return err
    }

    // Mark as accepted
    _, err = tx.ExecContext(
        ctx,
        `UPDATE invitations SET accepted_at = NOW() WHERE id = $1`,
        invID,
    )
    if err != nil {
        return err
    }

    // Add user to org
    _, err = tx.ExecContext(
        ctx,
        `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
        orgID, userID, role,
    )
    if err != nil {
        return err
    }

    return tx.Commit()
}