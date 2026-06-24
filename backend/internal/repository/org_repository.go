package repository

import (
    "context"
    "database/sql"
    "errors"

    "github.com/charkhaniakash/forge-engine/backend/internal/models"
)

type OrgRepository struct {
    db *sql.DB
}

func NewOrgRepository(db *sql.DB) *OrgRepository {
    return &OrgRepository{db: db}
}

// CreateOrg inserts a new organization
func (r *OrgRepository) CreateOrg(ctx context.Context, name, ownerID string) (*models.Organization, error) {
    org := &models.Organization{
        Name:    name,
        OwnerID: ownerID,
    }

    err := r.db.QueryRowContext(
        ctx,
        `INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id, created_at, updated_at`,
        name, ownerID,
    ).Scan(&org.ID, &org.CreatedAt, &org.UpdatedAt)

    if err != nil {
        return nil, err
    }

    // Add owner as member with owner role
    _, err = r.db.ExecContext(
        ctx,
        `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
        org.ID, ownerID, "owner",
    )

    return org, err
}

// GetOrgByID retrieves an org by ID
func (r *OrgRepository) GetOrgByID(ctx context.Context, id string) (*models.Organization, error) {
    org := &models.Organization{}
    err := r.db.QueryRowContext(
        ctx,
        `SELECT id, name, owner_id, created_at, updated_at FROM organizations WHERE id = $1`,
        id,
    ).Scan(&org.ID, &org.Name, &org.OwnerID, &org.CreatedAt, &org.UpdatedAt)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, errors.New("org not found")
        }
        return nil, err
    }

    return org, nil
}

// ListUserOrgs retrieves all orgs a user belongs to
func (r *OrgRepository) ListUserOrgs(ctx context.Context, userID string) ([]*models.Organization, error) {
    rows, err := r.db.QueryContext(
        ctx,
        `SELECT o.id, o.name, o.owner_id, o.created_at, o.updated_at 
         FROM organizations o
         JOIN organization_members om ON o.id = om.org_id
         WHERE om.user_id = $1
         ORDER BY o.created_at DESC`,
        userID,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var orgs []*models.Organization
    for rows.Next() {
        org := &models.Organization{}
        err := rows.Scan(&org.ID, &org.Name, &org.OwnerID, &org.CreatedAt, &org.UpdatedAt)
        if err != nil {
            return nil, err
        }
        orgs = append(orgs, org)
    }

    return orgs, rows.Err()
}

// GetUserOrgRole returns a user's role in an org
func (r *OrgRepository) GetUserOrgRole(ctx context.Context, orgID, userID string) (string, error) {
    var role string
    err := r.db.QueryRowContext(
        ctx,
        `SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2`,
        orgID, userID,
    ).Scan(&role)

    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return "", errors.New("user not member of org")
        }
        return "", err
    }

    return role, nil
}

// ListOrgMembers returns all members of an org
func (r *OrgRepository) ListOrgMembers(ctx context.Context, orgID string) ([]*models.OrganizationMember, error) {
    rows, err := r.db.QueryContext(
        ctx,
        `SELECT id, org_id, user_id, role, created_at, updated_at FROM organization_members WHERE org_id = $1`,
        orgID,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var members []*models.OrganizationMember
    for rows.Next() {
        member := &models.OrganizationMember{}
        err := rows.Scan(&member.ID, &member.OrgID, &member.UserID, &member.Role, &member.CreatedAt, &member.UpdatedAt)
        if err != nil {
            return nil, err
        }
        members = append(members, member)
    }

    return members, rows.Err()
}