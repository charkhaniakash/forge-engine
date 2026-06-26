package repository

import (
    "context"
    "crypto/rand"
    "crypto/sha256"
    "database/sql"
    "encoding/hex"
    "errors"
    "time"

    "github.com/charkhaniakash/forge-engine/backend/internal/models"
    "github.com/google/uuid"
)

type PendingInstallRepository struct {
    db *sql.DB
}

func hashStateToken(state string) string {
    h := sha256.Sum256([]byte(state))
    return hex.EncodeToString(h[:])
}

func NewPendingInstallRepository(db *sql.DB) *PendingInstallRepository {
    return &PendingInstallRepository{db: db}
}

func (r *PendingInstallRepository) MarkCallbackSeen(ctx context.Context, id string) error {
    _, err := r.db.ExecContext(ctx,
        `UPDATE pending_installs SET callback_seen = true WHERE id = $1 AND callback_seen = false`,
        id,
    )
    return err
}

func (r *PendingInstallRepository) ValidatePendingInstallByStateToken(ctx context.Context, stateToken string) (*models.PendingInstall, error) {
    return r.ValidatePendingInstall(ctx, stateToken)
}

func (r *PendingInstallRepository) MarkUsed(ctx context.Context, id string) error {
    _, err := r.db.ExecContext(ctx,
        `UPDATE pending_installs SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
        id,
    )
    return err
}

func (r *PendingInstallRepository) MarkPendingInstallUsed(ctx context.Context, id string) error {
    return r.MarkUsed(ctx, id)
}

func (r *PendingInstallRepository) GetByCallbackSeen(ctx context.Context) (*models.PendingInstall, error) {
    query := `
        SELECT id, org_id, state_token_hash, csrf_token, created_at, expires_at
        FROM pending_installs
        WHERE callback_seen = true
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
    `

    var p models.PendingInstall
    var stateHash string
    err := r.db.QueryRowContext(ctx, query).Scan(
        &p.ID,
        &p.OrgID,
        &stateHash,
        &p.CSRFToken,
        &p.CreatedAt,
        &p.ExpiresAt,
    )
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, nil
        }
        return nil, err
    }
    return &p, nil
}

func (r *PendingInstallRepository) GetPendingInstallForCallback(ctx context.Context) (*models.PendingInstall, error) {
    return r.GetByCallbackSeen(ctx)
}

func (r *PendingInstallRepository) ValidatePendingInstallByHash(ctx context.Context, stateHash string) (*models.PendingInstall, error) {
    query := `
        SELECT id, org_id, state_token_hash, csrf_token, created_at, expires_at
        FROM pending_installs
        WHERE state_token_hash = $1
    `
    var p models.PendingInstall
    var storedHash string
    err := r.db.QueryRowContext(ctx, query, stateHash).Scan(
        &p.ID,
        &p.OrgID,
        &storedHash,
        &p.CSRFToken,
        &p.CreatedAt,
        &p.ExpiresAt,
    )
    if err != nil {
        return nil, err
    }

    if time.Now().After(p.ExpiresAt) {
        _ = r.DeleteByStateTokenHash(ctx, storedHash)
        return nil, ErrPendingInstallExpired
    }
    return &p, nil
}

func (r *PendingInstallRepository) DeleteByStateTokenHash(ctx context.Context, stateTokenHash string) error {
    _, err := r.db.ExecContext(ctx,
        `DELETE FROM pending_installs WHERE state_token_hash = $1`,
        stateTokenHash,
    )
    return err
}

func (r *PendingInstallRepository) CreatePendingInstall(ctx context.Context, orgID string, expiresIn time.Duration) (*models.PendingInstall, string, error) {
    id := uuid.New().String()
    now := time.Now()
    expiresAt := now.Add(expiresIn)

    stateTokenBytes := make([]byte, 32)
    if _, err := rand.Read(stateTokenBytes); err != nil {
        return nil, "", err
    }
    stateToken := hex.EncodeToString(stateTokenBytes)
    stateTokenHash := hashStateToken(stateToken)

    csrfTokenBytes := make([]byte, 16)
    if _, err := rand.Read(csrfTokenBytes); err != nil {
        return nil, "", err
    }
    csrfToken := hex.EncodeToString(csrfTokenBytes)

    query := `
        INSERT INTO pending_installs (
            id,
            org_id,
            state_token,
            state_token_hash,
            csrf_token,
            created_at,
            expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, org_id, state_token, csrf_token, created_at, expires_at
    `
    var pendingInstall models.PendingInstall
    err := r.db.QueryRowContext(ctx, query,
        id,
        orgID,
        stateToken,
        stateTokenHash,
        csrfToken,
        now,
        expiresAt,
    ).Scan(
        &pendingInstall.ID,
        &pendingInstall.OrgID,
        &pendingInstall.StateToken,
        &pendingInstall.CSRFToken,
        &pendingInstall.CreatedAt,
        &pendingInstall.ExpiresAt,
    )
    if err != nil {
        return nil, "", err
    }

    return &pendingInstall, stateToken, nil
}

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

func (r *PendingInstallRepository) DeletePendingInstall(ctx context.Context, id string) error {
    _, err := r.db.ExecContext(ctx, `DELETE FROM pending_installs WHERE id = $1`, id)
    return err
}

func (r *PendingInstallRepository) DeleteByStateToken(ctx context.Context, stateToken string) error {
    _, err := r.db.ExecContext(ctx, `DELETE FROM pending_installs WHERE state_token = $1`, stateToken)
    return err
}

func (r *PendingInstallRepository) DeleteExpired(ctx context.Context) error {
    _, err := r.db.ExecContext(ctx, `DELETE FROM pending_installs WHERE expires_at < NOW()`)
    return err
}

func (r *PendingInstallRepository) ValidatePendingInstall(ctx context.Context, stateToken string) (*models.PendingInstall, error) {
    pendingInstall, err := r.GetByStateToken(ctx, stateToken)
    if err != nil {
        return nil, err
    }
    if time.Now().After(pendingInstall.ExpiresAt) {
        _ = r.DeleteByStateToken(ctx, stateToken)
        return nil, ErrPendingInstallExpired
    }
    return pendingInstall, nil
}

var (
    ErrPendingInstallExpired = errors.New("pending install has expired")
)