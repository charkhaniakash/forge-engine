package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
)

// QARepository handles persistence for qa_sessions and qa_messages.
// Go owns all session/message state — the Agent never writes to these tables.
type QARepository struct {
	db *sql.DB
}

func NewQARepository(db *sql.DB) *QARepository {
	return &QARepository{db: db}
}

// ── Sessions ──────────────────────────────────────────────────────────────────

// CreateSession creates a new Q&A session pinned to the given commit SHA.
// title is initially NULL and set when the first message is persisted.
func (r *QARepository) CreateSession(
	ctx context.Context,
	repoID, orgID, userID, commitSHA string,
) (*models.QASession, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO qa_sessions (id, repo_id, org_id, user_id, commit_sha, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
		RETURNING id, repo_id, org_id, user_id, commit_sha, title, workspace_id, created_at, updated_at
	`, id, repoID, orgID, userID, commitSHA, now)

	return scanSession(row)
}

// GetSessionByID returns a session by its UUID, verifying it belongs to the given org.
func (r *QARepository) GetSessionByID(ctx context.Context, sessionID, orgID string) (*models.QASession, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, repo_id, org_id, user_id, commit_sha, title, workspace_id, created_at, updated_at
		FROM qa_sessions
		WHERE id = $1 AND org_id = $2
	`, sessionID, orgID)
	return scanSession(row)
}

// ListSessionsForRepo returns all sessions for a repo, newest first.
// Scoped to the calling user's org.
func (r *QARepository) ListSessionsForRepo(
	ctx context.Context,
	repoID, orgID string,
	limit, offset int,
) ([]*models.QASession, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, repo_id, org_id, user_id, commit_sha, title, workspace_id, created_at, updated_at
		FROM qa_sessions
		WHERE repo_id = $1 AND org_id = $2
		ORDER BY created_at DESC
		LIMIT $3 OFFSET $4
	`, repoID, orgID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []*models.QASession
	for rows.Next() {
		s, err := scanSessionRow(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}
	return sessions, rows.Err()
}

// SetSessionTitle sets the title on a session. Called after the first user
// message is persisted (title = first 120 chars of the question).
func (r *QARepository) SetSessionTitle(ctx context.Context, sessionID, title string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE qa_sessions SET title = $2, updated_at = NOW()
		WHERE id = $1
	`, sessionID, title)
	return err
}

// HealCommitSHA updates a session's commit_sha when it was stored empty.
// Called by Ask handler for sessions created before the UpdateCommitSHA fix.
func (r *QARepository) HealCommitSHA(ctx context.Context, sessionID, commitSHA string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE qa_sessions SET commit_sha = $2, updated_at = NOW()
		WHERE id = $1 AND commit_sha = ''
	`, sessionID, commitSHA)
	return err
}

// ── Messages ──────────────────────────────────────────────────────────────────

// AddMessage persists a single message (user or assistant) to a session.
// citations must be JSON-serialisable ([]map[string]any or nil).
func (r *QARepository) AddMessage(
	ctx context.Context,
	sessionID, role, content string,
	citations interface{},
	tokenCount *int,
	model *string,
	requestID *string,
) (*models.QAMessage, error) {
	id := uuid.New().String()
	now := time.Now()

	var citationsJSON []byte
	if citations != nil {
		var err error
		citationsJSON, err = json.Marshal(citations)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal citations: %w", err)
		}
	}

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO qa_messages
			(id, session_id, role, content, citations, token_count, model, request_id, created_at)
		VALUES
			($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, session_id, role, content, citations, token_count, model, request_id, created_at
	`, id, sessionID, role, content,
		nullableJSON(citationsJSON),
		tokenCount, model, requestID, now)

	return scanMessage(row)
}

// ListMessages returns all messages for a session in chronological order.
func (r *QARepository) ListMessages(ctx context.Context, sessionID string) ([]*models.QAMessage, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, session_id, role, content, citations, token_count, model, request_id, created_at
		FROM qa_messages
		WHERE session_id = $1
		ORDER BY created_at ASC
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*models.QAMessage
	for rows.Next() {
		m, err := scanMessageRow(rows)
		if err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// RecentMessages returns the last n messages for a session in chronological
// order. Used to build the history slice sent to the Agent.
func (r *QARepository) RecentMessages(ctx context.Context, sessionID string, n int) ([]*models.QAMessage, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, session_id, role, content, citations, token_count, model, request_id, created_at
		FROM (
			SELECT * FROM qa_messages WHERE session_id = $1
			ORDER BY created_at DESC LIMIT $2
		) sub
		ORDER BY created_at ASC
	`, sessionID, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*models.QAMessage
	for rows.Next() {
		m, err := scanMessageRow(rows)
		if err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanSession(row *sql.Row) (*models.QASession, error) {
	var s models.QASession
	var title, workspaceID sql.NullString
	err := row.Scan(
		&s.ID, &s.RepoID, &s.OrgID, &s.UserID, &s.CommitSHA,
		&title, &workspaceID,
		&s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if title.Valid {
		s.Title = &title.String
	}
	if workspaceID.Valid {
		s.WorkspaceID = &workspaceID.String
	}
	return &s, nil
}

func scanSessionRow(rows *sql.Rows) (*models.QASession, error) {
	var s models.QASession
	var title, workspaceID sql.NullString
	err := rows.Scan(
		&s.ID, &s.RepoID, &s.OrgID, &s.UserID, &s.CommitSHA,
		&title, &workspaceID,
		&s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if title.Valid {
		s.Title = &title.String
	}
	if workspaceID.Valid {
		s.WorkspaceID = &workspaceID.String
	}
	return &s, nil
}

func scanMessage(row *sql.Row) (*models.QAMessage, error) {
	var m models.QAMessage
	var citationsRaw []byte
	var tokenCount sql.NullInt32
	var model, requestID sql.NullString

	err := row.Scan(
		&m.ID, &m.SessionID, &m.Role, &m.Content,
		&citationsRaw, &tokenCount, &model, &requestID,
		&m.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if len(citationsRaw) > 0 {
		var c interface{}
		if jsonErr := json.Unmarshal(citationsRaw, &c); jsonErr == nil {
			m.Citations = c
		}
	}
	if tokenCount.Valid {
		n := int(tokenCount.Int32)
		m.TokenCount = &n
	}
	if model.Valid {
		m.Model = &model.String
	}
	if requestID.Valid {
		m.RequestID = &requestID.String
	}
	return &m, nil
}

func scanMessageRow(rows *sql.Rows) (*models.QAMessage, error) {
	var m models.QAMessage
	var citationsRaw []byte
	var tokenCount sql.NullInt32
	var model, requestID sql.NullString

	err := rows.Scan(
		&m.ID, &m.SessionID, &m.Role, &m.Content,
		&citationsRaw, &tokenCount, &model, &requestID,
		&m.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if len(citationsRaw) > 0 {
		var c interface{}
		if jsonErr := json.Unmarshal(citationsRaw, &c); jsonErr == nil {
			m.Citations = c
		}
	}
	if tokenCount.Valid {
		n := int(tokenCount.Int32)
		m.TokenCount = &n
	}
	if model.Valid {
		m.Model = &model.String
	}
	if requestID.Valid {
		m.RequestID = &requestID.String
	}
	return &m, nil
}

// nullableJSON returns nil if the slice is empty, otherwise the raw bytes.
// Avoids inserting empty arrays as NULL.
func nullableJSON(b []byte) interface{} {
	if len(b) == 0 {
		return nil
	}
	return b
}
