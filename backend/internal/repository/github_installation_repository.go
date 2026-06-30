package repository

import (
	"context"
	"database/sql"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
)

type GitHubInstallationRepository struct {
	db *sql.DB
}

func NewGitHubInstallationRepository(db *sql.DB) *GitHubInstallationRepository {
	return &GitHubInstallationRepository{db: db}
}

// CreateInstallation creates a new GitHub installation
func (r *GitHubInstallationRepository) CreateInstallation(
	ctx context.Context,
	orgID string,
	githubInstallationID int64,
	githubAccountID int64,
	githubAccountLogin string,
) (*models.GitHubInstallation, error) {
	id := uuid.New().String()
	now := time.Now()

	query := `
		INSERT INTO github_installations (id, org_id, github_installation_id, github_account_id, github_account_login, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, org_id, github_installation_id, github_account_id, github_account_login, access_token, token_expires_at, created_at, updated_at
	`

	var accessToken sql.NullString
	var tokenExpiresAt sql.NullTime

	var installation models.GitHubInstallation
	err := r.db.QueryRowContext(ctx, query, id, orgID, githubInstallationID, githubAccountID, githubAccountLogin, now, now).Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.GitHubInstallationID,
		&installation.GitHubAccountID,
		&installation.GitHubAccountLogin,
		&accessToken,
		&tokenExpiresAt,
		&installation.CreatedAt,
		&installation.UpdatedAt,
	)

	if err != nil {
		return nil, err
	}

	if accessToken.Valid {
		installation.AccessToken = accessToken.String
	} else {
		installation.AccessToken = ""
	}

	if tokenExpiresAt.Valid {
		installation.TokenExpiresAt = &tokenExpiresAt.Time
	}

	return &installation, nil
}

// GetByOrgID retrieves a GitHub installation by org ID
func (r *GitHubInstallationRepository) GetByOrgID(ctx context.Context, orgID string) (*models.GitHubInstallation, error) {
	query := `
		SELECT id, org_id, github_installation_id, github_account_id, github_account_login, access_token, token_expires_at, created_at, updated_at
		FROM github_installations
		WHERE org_id = $1
	`

	var accessToken sql.NullString
	var tokenExpiresAt sql.NullTime

	var installation models.GitHubInstallation
	err := r.db.QueryRowContext(ctx, query, orgID).Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.GitHubInstallationID,
		&installation.GitHubAccountID,
		&installation.GitHubAccountLogin,
		&accessToken,
		&tokenExpiresAt,
		&installation.CreatedAt,
		&installation.UpdatedAt,
	)

	if err != nil {
		return nil, err
	}

	if accessToken.Valid {
		installation.AccessToken = accessToken.String
	} else {
		installation.AccessToken = ""
	}

	if tokenExpiresAt.Valid {
		installation.TokenExpiresAt = &tokenExpiresAt.Time
	}

	return &installation, nil
}

// GetByGitHubInstallationID retrieves a GitHub installation by GitHub installation ID
func (r *GitHubInstallationRepository) GetByGitHubInstallationID(ctx context.Context, githubInstallationID int64) (*models.GitHubInstallation, error) {
	query := `
		SELECT id, org_id, github_installation_id, github_account_id, github_account_login, access_token, token_expires_at, created_at, updated_at
		FROM github_installations
		WHERE github_installation_id = $1
	`

	var accessToken sql.NullString
	var tokenExpiresAt sql.NullTime

	var installation models.GitHubInstallation
	err := r.db.QueryRowContext(ctx, query, githubInstallationID).Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.GitHubInstallationID,
		&installation.GitHubAccountID,
		&installation.GitHubAccountLogin,
		&accessToken,
		&tokenExpiresAt,
		&installation.CreatedAt,
		&installation.UpdatedAt,
	)

	if err != nil {
		return nil, err
	}

	if accessToken.Valid {
		installation.AccessToken = accessToken.String
	} else {
		installation.AccessToken = ""
	}

	if tokenExpiresAt.Valid {
		installation.TokenExpiresAt = &tokenExpiresAt.Time
	}

	return &installation, nil
}

// UpdateAccessToken updates the cached access token and expiry
func (r *GitHubInstallationRepository) UpdateAccessToken(
	ctx context.Context,
	id string,
	accessToken string,
	expiresAt time.Time,
) error {
	query := `
		UPDATE github_installations
		SET access_token = $2, token_expires_at = $3, updated_at = $4
		WHERE id = $1
	`

	_, err := r.db.ExecContext(ctx, query, id, accessToken, expiresAt, time.Now())
	return err
}

// DeleteInstallation deletes a GitHub installation
func (r *GitHubInstallationRepository) DeleteInstallation(ctx context.Context, id string) error {
	query := `DELETE FROM github_installations WHERE id = $1`
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}

// GetByID retrieves a GitHub installation by its internal UUID.
func (r *GitHubInstallationRepository) GetByID(ctx context.Context, id string) (*models.GitHubInstallation, error) {
	query := `
		SELECT id, org_id, github_installation_id, github_account_id, github_account_login, access_token, token_expires_at, created_at, updated_at
		FROM github_installations
		WHERE id = $1
	`
	var accessToken sql.NullString
	var tokenExpiresAt sql.NullTime
	var installation models.GitHubInstallation

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.GitHubInstallationID,
		&installation.GitHubAccountID,
		&installation.GitHubAccountLogin,
		&accessToken,
		&tokenExpiresAt,
		&installation.CreatedAt,
		&installation.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if accessToken.Valid {
		installation.AccessToken = accessToken.String
	}
	if tokenExpiresAt.Valid {
		installation.TokenExpiresAt = &tokenExpiresAt.Time
	}
	return &installation, nil
}
