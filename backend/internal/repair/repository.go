package repair

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

// RepairRepository manages persistence for the three repair tables.
type RepairRepository struct {
	db *sql.DB
}

// NewRepairRepository constructs a RepairRepository.
func NewRepairRepository(db *sql.DB) *RepairRepository {
	return &RepairRepository{db: db}
}

// ── repair_sessions ───────────────────────────────────────────────────────────

// CreateSession inserts a new repair_sessions row.
func (r *RepairRepository) CreateSession(
	ctx context.Context,
	taskExecID, workspaceID, triggerRunID string,
	maxAttempts, maxDurationSecs int,
) (*models.RepairSession, error) {
	id := uuid.New().String()
	now := time.Now()
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO repair_sessions
			(id, task_execution_id, workspace_id, trigger_validation_run_id,
			 max_attempts, attempts_used, max_duration_secs, status, started_at, created_at)
		VALUES ($1,$2,$3,$4,$5,0,$6,'running',$7,$7)
		RETURNING id, task_execution_id, workspace_id, trigger_validation_run_id,
		          max_attempts, attempts_used, max_duration_secs, status,
		          final_validation_run_id, escalation_reason,
		          started_at, completed_at, created_at
	`, id, taskExecID, workspaceID, triggerRunID, maxAttempts, maxDurationSecs, now)
	return scanSession(row)
}

// GetSession fetches a repair session by ID.
func (r *RepairRepository) GetSession(ctx context.Context, id string) (*models.RepairSession, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, workspace_id, trigger_validation_run_id,
		       max_attempts, attempts_used, max_duration_secs, status,
		       final_validation_run_id, escalation_reason,
		       started_at, completed_at, created_at
		FROM repair_sessions WHERE id = $1
	`, id)
	return scanSession(row)
}

// GetLatestForTaskExecution returns the most recent session for a task execution.
func (r *RepairRepository) GetLatestForTaskExecution(ctx context.Context, taskExecID string) (*models.RepairSession, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, workspace_id, trigger_validation_run_id,
		       max_attempts, attempts_used, max_duration_secs, status,
		       final_validation_run_id, escalation_reason,
		       started_at, completed_at, created_at
		FROM repair_sessions
		WHERE task_execution_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, taskExecID)
	return scanSession(row)
}

// IncrementAttempts increments attempts_used by 1.
func (r *RepairRepository) IncrementAttempts(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE repair_sessions SET attempts_used = attempts_used + 1 WHERE id = $1`, id)
	return err
}

// MarkCompleted transitions the session to 'completed'.
func (r *RepairRepository) MarkCompleted(ctx context.Context, id, finalRunID string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE repair_sessions
		SET status='completed', final_validation_run_id=$2, completed_at=NOW()
		WHERE id=$1
	`, id, finalRunID)
	return err
}

// MarkExhausted transitions the session to 'exhausted'.
func (r *RepairRepository) MarkExhausted(ctx context.Context, id, finalRunID string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE repair_sessions
		SET status='exhausted', final_validation_run_id=$2, completed_at=NOW()
		WHERE id=$1
	`, id, finalRunID)
	return err
}

// MarkEscalated transitions the session to 'escalated'.
func (r *RepairRepository) MarkEscalated(ctx context.Context, id, reason string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE repair_sessions
		SET status='escalated', escalation_reason=$2, completed_at=NOW()
		WHERE id=$1
	`, id, reason)
	return err
}

// MarkCancelled transitions the session to 'cancelled'.
func (r *RepairRepository) MarkCancelled(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE repair_sessions SET status='cancelled', completed_at=NOW() WHERE id=$1`, id)
	return err
}

// ── repair_attempts ───────────────────────────────────────────────────────────
// Note: the repair timeline (stream events) is persisted as a "timeline" field
// inside the reasoning JSONB column rather than a separate table.

// CreateAttempt inserts a new repair_attempts row.
func (r *RepairRepository) CreateAttempt(
	ctx context.Context,
	sessionID string,
	attemptNumber int,
	diagnosticsInput json.RawMessage,
	agentVersion string,
) (*models.RepairAttempt, error) {
	id := uuid.New().String()
	now := time.Now()
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO repair_attempts
			(id, repair_session_id, attempt_number, diagnostics_input, agent_version, started_at, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$6)
		RETURNING id, repair_session_id, attempt_number, diagnostics_input,
		          reasoning, strategy, confidence, modified_files, validation_run_id,
		          outcome, agent_version, started_at, completed_at, created_at
	`, id, sessionID, attemptNumber, diagnosticsInput, agentVersion, now)
	return scanAttempt(row)
}

// GetAttempt fetches a single attempt by ID.
func (r *RepairRepository) GetAttempt(ctx context.Context, id string) (*models.RepairAttempt, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, repair_session_id, attempt_number, diagnostics_input,
		       reasoning, strategy, confidence, modified_files, validation_run_id,
		       outcome, agent_version, started_at, completed_at, created_at
		FROM repair_attempts WHERE id = $1
	`, id)
	return scanAttempt(row)
}

// ListAttemptsForSession returns all attempts for a session, ordered by attempt_number.
func (r *RepairRepository) ListAttemptsForSession(ctx context.Context, sessionID string) ([]*models.RepairAttempt, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, repair_session_id, attempt_number, diagnostics_input,
		       reasoning, strategy, confidence, modified_files, validation_run_id,
		       outcome, agent_version, started_at, completed_at, created_at
		FROM repair_attempts
		WHERE repair_session_id = $1
		ORDER BY attempt_number ASC
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attempts []*models.RepairAttempt
	for rows.Next() {
		att, err := scanAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, att)
	}
	return attempts, rows.Err()
}

// UpdateAttemptResult updates the outcome fields after the graph completes.
func (r *RepairRepository) UpdateAttemptResult(
	ctx context.Context,
	id string,
	reasoning json.RawMessage,
	strategy *string,
	confidence *float64,
	modifiedFiles []string,
	validationRunID *string,
	outcome *string,
) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE repair_attempts
		SET reasoning=$2, strategy=$3, confidence=$4, modified_files=$5,
		    validation_run_id=$6, outcome=$7, completed_at=NOW()
		WHERE id=$1
	`, id, reasoning, strategy, confidence, pq.Array(modifiedFiles), validationRunID, outcome)
	return err
}

// ── repair_checkpoints ────────────────────────────────────────────────────────

// CreateCheckpoint inserts a new repair_checkpoints row.
func (r *RepairRepository) CreateCheckpoint(
	ctx context.Context,
	sessionID string,
	attemptNumber int,
	modifiedFiles, createdFiles, deletedFiles []string,
	unifiedDiffs json.RawMessage,
) (*models.RepairCheckpoint, error) {
	id := uuid.New().String()
	now := time.Now()
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO repair_checkpoints
			(id, repair_session_id, attempt_number, modified_files, created_files,
			 deleted_files, unified_diffs, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id, repair_session_id, attempt_number, modified_files, created_files,
		          deleted_files, unified_diffs, container_snapshot_id, created_at
	`, id, sessionID, attemptNumber, pq.Array(modifiedFiles), pq.Array(createdFiles),
		pq.Array(deletedFiles), unifiedDiffs, now)
	return scanCheckpoint(row)
}

// GetCheckpoint fetches a checkpoint by (session_id, attempt_number).
func (r *RepairRepository) GetCheckpoint(ctx context.Context, sessionID string, attemptNumber int) (*models.RepairCheckpoint, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, repair_session_id, attempt_number, modified_files, created_files,
		       deleted_files, unified_diffs, container_snapshot_id, created_at
		FROM repair_checkpoints
		WHERE repair_session_id=$1 AND attempt_number=$2
	`, sessionID, attemptNumber)
	return scanCheckpoint(row)
}

// ListCheckpointsForSession returns all checkpoints for a session.
func (r *RepairRepository) ListCheckpointsForSession(ctx context.Context, sessionID string) ([]*models.RepairCheckpoint, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, repair_session_id, attempt_number, modified_files, created_files,
		       deleted_files, unified_diffs, container_snapshot_id, created_at
		FROM repair_checkpoints
		WHERE repair_session_id=$1
		ORDER BY attempt_number ASC
	`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cps []*models.RepairCheckpoint
	for rows.Next() {
		cp, err := scanCheckpoint(rows)
		if err != nil {
			return nil, err
		}
		cps = append(cps, cp)
	}
	return cps, rows.Err()
}

// ── scanners ──────────────────────────────────────────────────────────────────

type scanner interface {
	Scan(dest ...interface{}) error
}

func scanSession(sc scanner) (*models.RepairSession, error) {
	var s models.RepairSession
	var finalRunID, escalationReason sql.NullString
	var completedAt sql.NullTime
	err := sc.Scan(
		&s.ID, &s.TaskExecutionID, &s.WorkspaceID, &s.TriggerValidationRunID,
		&s.MaxAttempts, &s.AttemptsUsed, &s.MaxDurationSecs, &s.Status,
		&finalRunID, &escalationReason,
		&s.StartedAt, &completedAt, &s.CreatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("repair session not found")
		}
		return nil, err
	}
	if finalRunID.Valid {
		s.FinalValidationRunID = &finalRunID.String
	}
	if escalationReason.Valid {
		s.EscalationReason = &escalationReason.String
	}
	if completedAt.Valid {
		s.CompletedAt = &completedAt.Time
	}
	return &s, nil
}

func scanAttempt(sc scanner) (*models.RepairAttempt, error) {
	var a models.RepairAttempt
	var reasoning json.RawMessage
	var strategy, validationRunID, outcome sql.NullString
	var confidence sql.NullFloat64
	var completedAt sql.NullTime
	err := sc.Scan(
		&a.ID, &a.RepairSessionID, &a.AttemptNumber, &a.DiagnosticsInput,
		&reasoning, &strategy, &confidence, pq.Array(&a.ModifiedFiles), &validationRunID,
		&outcome, &a.AgentVersion, &a.StartedAt, &completedAt, &a.CreatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("repair attempt not found")
		}
		return nil, err
	}
	if len(reasoning) > 0 {
		a.Reasoning = reasoning
	}
	if strategy.Valid {
		a.Strategy = &strategy.String
	}
	if confidence.Valid {
		a.Confidence = &confidence.Float64
	}
	if validationRunID.Valid {
		a.ValidationRunID = &validationRunID.String
	}
	if outcome.Valid {
		a.Outcome = &outcome.String
	}
	if completedAt.Valid {
		a.CompletedAt = &completedAt.Time
	}
	return &a, nil
}

func scanCheckpoint(sc scanner) (*models.RepairCheckpoint, error) {
	var cp models.RepairCheckpoint
	var snapshotID sql.NullString
	err := sc.Scan(
		&cp.ID, &cp.RepairSessionID, &cp.AttemptNumber,
		pq.Array(&cp.ModifiedFiles), pq.Array(&cp.CreatedFiles), pq.Array(&cp.DeletedFiles),
		&cp.UnifiedDiffs, &snapshotID, &cp.CreatedAt,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("repair checkpoint not found")
		}
		return nil, err
	}
	if snapshotID.Valid {
		cp.ContainerSnapshotID = &snapshotID.String
	}
	return &cp, nil
}
