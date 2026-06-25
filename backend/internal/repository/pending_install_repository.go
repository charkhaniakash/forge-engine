package repository

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
)

// PendingInstallRepository handles pending GitHub installation records
type PendingInstallRepository struct {
	db *sql.DB
}

// NewPendingInstallRepository creates a new pending install repository
func NewPendingInstallRepository(db *sql.DB) *PendingInstallRepository {
	return &PendingInstallRepository{db: db}
}

// CreatePendingInstall creates a new pending install record with a state token
func (r *PendingInstallRepository) CreatePendingInstall(
	ctx context.Context,
	orgID string,
	expiresIn time.Duration,
) (*models.PendingInstall, error) {
	id := uuid.New().String()
	now := time.Now()
	expiresAt := now.Add(expiresIn)

	// Generate state token (32 bytes = 64 hex chars)
	stateTokenBytes := make([]byte, 32)
	if _, err := rand.Read(stateTokenBytes); err != nil {
		return nil, err
	}
	stateToken := hex.EncodeToString(stateTokenBytes)

	// Generate CSRF token (16 bytes = 32 hex chars)
	csrfTokenBytes := make([]byte, 16)
	if _, err := rand.Read(csrfTokenBytes); err != nil {
		return nil, err
	}
	csrfToken := hex.EncodeToString(csrfTokenBytes)

	query := `
		INSERT INTO pending_installs (id, org_id, state_token, csrf_token, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, org_id, state_token, csrf_token, created_at, expires_at
	`

	var pendingInstall models.PendingInstall
	err := r.db.QueryRowContext(ctx, query, id, orgID, stateToken, csrfToken, now, expiresAt).Scan(
		&pendingInstall.ID,
		&pendingInstall.OrgID,
		&pendingInstall.StateToken,
		&pendingInstall.CSRFToken,
		&pendingInstall.CreatedAt,
		&pendingInstall.ExpiresAt,
	)

	if err != nil {
		return nil, err
	}

	return &pendingInstall, nil
}

// GetByStateToken retrieves a pending install by state token
func (r *PendingInstallRepository) GetByStateToken(ctx context.Context, stateToken string) (*models.PendingInstall, error) {
	query := `
		SELECT id, org_id, state_token, csrf_token, created_at, expires_at
		FROM pending_installs
		WHERE state_token = $1
	`

	var pendingInstall models.PendingInstall
	err := r.db.QueryRowContext(ctx, query, stateToken).Scan(
		&pendingInstall.ID,
		&pendingInstall.OrgID,
		&pendingInstall.StateToken,
		&pendingInstall.CSRFToken,
		&pendingInstall.CreatedAt,
		&pendingInstall.ExpiresAt,
	)

	if err != nil {
		return nil, err
	}

	return &pendingInstall, nil
}

// GetByOrgID retrieves a pending install by org ID
func (r *PendingInstallRepository) GetByOrgID(ctx context.Context, orgID string) (*models.PendingInstall, error) {
	query := `
		SELECT id, org_id, state_token, csrf_token, created_at, expires_at
		FROM pending_installs
		WHERE org_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`

	var pendingInstall models.PendingInstall
	err := r.db.QueryRowContext(ctx, query, orgID).Scan(
		&pendingInstall.ID,
		&pendingInstall.OrgID,
		&pendingInstall.StateToken,
		&pendingInstall.CSRFToken,
		&pendingInstall.CreatedAt,
		&pendingInstall.ExpiresAt,
	)

	if err != nil {
		return nil, err
	}

	return &pendingInstall, nil
}

// DeletePendingInstall deletes a pending install record
func (r *PendingInstallRepository) DeletePendingInstall(ctx context.Context, id string) error {
	query := `DELETE FROM pending_installs WHERE id = $1`
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}

// DeleteByStateToken deletes a pending install by state token
func (r *PendingInstallRepository) DeleteByStateToken(ctx context.Context, stateToken string) error {
	query := `DELETE FROM pending_installs WHERE state_token = $1`
	_, err := r.db.ExecContext(ctx, query, stateToken)
	return err
}

// DeleteExpired deletes all expired pending install records
func (r *PendingInstallRepository) DeleteExpired(ctx context.Context) error {
	query := `DELETE FROM pending_installs WHERE expires_at < NOW()`
	_, err := r.db.ExecContext(ctx, query)
	return err
}

// ValidatePendingInstall checks if a pending install is valid and not expired
func (r *PendingInstallRepository) ValidatePendingInstall(ctx context.Context, stateToken string) (*models.PendingInstall, error) {
	pendingInstall, err := r.GetByStateToken(ctx, stateToken)
	if err != nil {
		return nil, err
	}

	// Check if expired
	if time.Now().After(pendingInstall.ExpiresAt) {
		// Clean up expired record
		_ = r.DeleteByStateToken(ctx, stateToken)
		return nil, ErrPendingInstallExpired
	}

	return pendingInstall, nil
}

// Custom errors
var (
	ErrPendingInstallExpired = errors.New("pending install has expired")
)
