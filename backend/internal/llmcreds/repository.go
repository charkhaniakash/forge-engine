package llmcreds

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) Upsert(ctx context.Context, orgID, userID, provider, model, encrypted, hint string, validatedAt *time.Time, activate bool) (*Credential, error) {
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO llm_credentials (
			org_id, user_id, provider, model, api_key_encrypted, key_hint, validated_at, is_active
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (org_id, provider) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			model = EXCLUDED.model,
			api_key_encrypted = CASE
				WHEN EXCLUDED.api_key_encrypted = '' THEN llm_credentials.api_key_encrypted
				ELSE EXCLUDED.api_key_encrypted
			END,
			key_hint = CASE
				WHEN EXCLUDED.key_hint = '' THEN llm_credentials.key_hint
				ELSE EXCLUDED.key_hint
			END,
			validated_at = COALESCE(EXCLUDED.validated_at, llm_credentials.validated_at),
			is_active = EXCLUDED.is_active,
			updated_at = CURRENT_TIMESTAMP
		RETURNING id, org_id, user_id, provider, model, key_hint, validated_at, is_active, created_at, updated_at
	`, orgID, userID, provider, model, encrypted, hint, validatedAt, activate)
	return scanCredential(row)
}

func (r *Repository) ListByOrg(ctx context.Context, orgID string) ([]*Credential, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, org_id, user_id, provider, model, key_hint, validated_at, is_active, created_at, updated_at
		FROM llm_credentials WHERE org_id = $1
		ORDER BY is_active DESC, updated_at DESC
	`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Credential
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r *Repository) GetActive(ctx context.Context, orgID string) (*stored, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, org_id, user_id, provider, model, api_key_encrypted, key_hint, validated_at, is_active, created_at, updated_at
		FROM llm_credentials WHERE org_id = $1 AND is_active = TRUE
		LIMIT 1
	`, orgID)
	return scanStored(row)
}

func (r *Repository) GetByProvider(ctx context.Context, orgID, provider string) (*stored, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, org_id, user_id, provider, model, api_key_encrypted, key_hint, validated_at, is_active, created_at, updated_at
		FROM llm_credentials WHERE org_id = $1 AND provider = $2
	`, orgID, provider)
	return scanStored(row)
}

func (r *Repository) Activate(ctx context.Context, orgID, provider string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE llm_credentials SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE org_id = $1`, orgID); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE llm_credentials SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
		WHERE org_id = $1 AND provider = $2
	`, orgID, provider)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("provider not configured")
	}
	return tx.Commit()
}

func (r *Repository) ClearActive(ctx context.Context, orgID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE llm_credentials SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE org_id = $1`, orgID)
	return err
}

func (r *Repository) Delete(ctx context.Context, orgID, provider string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM llm_credentials WHERE org_id = $1 AND provider = $2`, orgID, provider)
	return err
}

type stored struct {
	Credential
	Encrypted string
}

type scanner interface {
	Scan(dest ...any) error
}

func scanCredential(s scanner) (*Credential, error) {
	c := &Credential{}
	err := s.Scan(&c.ID, &c.OrgID, &c.UserID, &c.Provider, &c.Model, &c.KeyHint, &c.ValidatedAt, &c.IsActive, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return c, nil
}

func scanStored(s scanner) (*stored, error) {
	st := &stored{}
	err := s.Scan(
		&st.ID, &st.OrgID, &st.UserID, &st.Provider, &st.Model,
		&st.Encrypted, &st.KeyHint, &st.ValidatedAt, &st.IsActive, &st.CreatedAt, &st.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return st, nil
}
