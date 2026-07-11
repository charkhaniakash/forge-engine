package repository

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

// ExecutionRepository handles persistence for task_executions, step_executions,
// execution_events, code_diffs, and execution_checkpoints.
// Go owns every status transition — the agent never writes to these tables.
type ExecutionRepository struct {
	db *sql.DB
}

func NewExecutionRepository(db *sql.DB) *ExecutionRepository {
	return &ExecutionRepository{db: db}
}

// ── TaskExecution ─────────────────────────────────────────────────────────────

// CreateExecution inserts a new task_execution in 'pending' status.
func (r *ExecutionRepository) CreateExecution(
	ctx context.Context,
	workItemID, workspaceID, planID string,
	execCtx json.RawMessage,
) (*models.TaskExecution, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO task_executions
			(id, work_item_id, workspace_id, plan_id, status, execution_context, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)
		RETURNING id, work_item_id, workspace_id, plan_id, status,
		          current_step_stable_id, execution_context,
		          started_at, completed_at, error, created_at, updated_at
	`, id, workItemID, workspaceID, planID, execCtx, now)
	return scanExecution(row)
}

// GetExecution returns a task_execution by ID.
func (r *ExecutionRepository) GetExecution(ctx context.Context, id string) (*models.TaskExecution, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, workspace_id, plan_id, status,
		       current_step_stable_id, execution_context,
		       started_at, completed_at, error, created_at, updated_at
		FROM task_executions WHERE id = $1
	`, id)
	return scanExecution(row)
}

// UpdateExecutionContext overwrites the stored execution_context JSONB.
// Called after the task_execution_id is resolved post-insert.
func (r *ExecutionRepository) UpdateExecutionContext(ctx context.Context, id string, execCtx json.RawMessage) (*models.TaskExecution, error) {
	row := r.db.QueryRowContext(ctx, `
		UPDATE task_executions
		SET execution_context = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, work_item_id, workspace_id, plan_id, status,
		          current_step_stable_id, execution_context,
		          started_at, completed_at, error, created_at, updated_at
	`, id, execCtx)
	return scanExecution(row)
}

// GetLatestForWorkItem returns the most recent execution for a work item.
func (r *ExecutionRepository) GetLatestForWorkItem(ctx context.Context, workItemID string) (*models.TaskExecution, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, workspace_id, plan_id, status,
		       current_step_stable_id, execution_context,
		       started_at, completed_at, error, created_at, updated_at
		FROM task_executions
		WHERE work_item_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, workItemID)
	return scanExecution(row)
}

// MarkRunning transitions pending → running.
func (r *ExecutionRepository) MarkRunning(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE task_executions
		SET status = 'running', started_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status = 'pending'
	`, id)
	return err
}

// UpdateCurrentStep records which step is currently executing.
func (r *ExecutionRepository) UpdateCurrentStep(ctx context.Context, id, stepStableID string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE task_executions
		SET current_step_stable_id = $2, updated_at = NOW()
		WHERE id = $1
	`, id, stepStableID)
	return err
}

// MarkStepSkipped marks a step as skipped with a reason (blocked dependency).
func (r *ExecutionRepository) MarkStepSkipped(ctx context.Context, id, reason string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE step_executions
		SET status = 'skipped', deviation_note = $2, completed_at = NOW()
		WHERE id = $1
	`, id, reason)
	return err
}

// MarkCompletedWithStatus transitions to a final completed status.
// Accepts "completed" or "completed_with_deviations".
func (r *ExecutionRepository) MarkCompletedWithStatus(ctx context.Context, id, status string) error {
	if status != "completed" && status != "completed_with_deviations" {
		status = "completed"
	}
	_, err := r.db.ExecContext(ctx, `
		UPDATE task_executions
		SET status = $2, current_step_stable_id = NULL,
		    completed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, status)
	return err
}

// MarkCompleted transitions to completed (alias for backward compatibility).
func (r *ExecutionRepository) MarkCompleted(ctx context.Context, id string) error {
	return r.MarkCompletedWithStatus(ctx, id, "completed")
}

// MarkFailed transitions to failed with an error message.
func (r *ExecutionRepository) MarkFailed(ctx context.Context, id, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE task_executions
		SET status = 'failed', error = $2, completed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// MarkCancelled transitions to cancelled.
func (r *ExecutionRepository) MarkCancelled(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE task_executions
		SET status = 'cancelled', completed_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')
	`, id)
	return err
}

// ── StepExecution ─────────────────────────────────────────────────────────────

// CreateStepExecution inserts a step_execution in 'pending' status.
func (r *ExecutionRepository) CreateStepExecution(
	ctx context.Context,
	taskExecutionID, stepStableID string,
	stepOrder int,
) (*models.StepExecution, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO step_executions
			(id, task_execution_id, step_stable_id, step_order, status, created_at)
		VALUES ($1, $2, $3, $4, 'pending', $5)
		RETURNING id, task_execution_id, step_stable_id, step_order,
		          status, started_at, completed_at, reasoning, deviation_note, created_at
	`, id, taskExecutionID, stepStableID, stepOrder, now)
	return scanStepExecution(row)
}

// MarkStepRunning transitions a step to running.
func (r *ExecutionRepository) MarkStepRunning(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE step_executions
		SET status = 'running', started_at = NOW()
		WHERE id = $1 AND status = 'pending'
	`, id)
	return err
}

// MarkStepCompleted transitions a step to completed with a reasoning summary.
func (r *ExecutionRepository) MarkStepCompleted(ctx context.Context, id, reasoning string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE step_executions
		SET status = 'completed', reasoning = $2, completed_at = NOW()
		WHERE id = $1
	`, id, reasoning)
	return err
}

// MarkStepFailed transitions a step to failed.
func (r *ExecutionRepository) MarkStepFailed(ctx context.Context, id, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE step_executions
		SET status = 'failed', deviation_note = $2, completed_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// MarkStepDeviated marks a step as deviated with an explanation.
func (r *ExecutionRepository) MarkStepDeviated(ctx context.Context, id, note string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE step_executions
		SET status = 'deviated', deviation_note = $2, completed_at = NOW()
		WHERE id = $1
	`, id, note)
	return err
}

// ListStepExecutions returns all step executions for a task in order.
func (r *ExecutionRepository) ListStepExecutions(ctx context.Context, taskExecutionID string) ([]*models.StepExecution, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, task_execution_id, step_stable_id, step_order,
		       status, started_at, completed_at, reasoning, deviation_note, created_at
		FROM step_executions
		WHERE task_execution_id = $1
		ORDER BY step_order ASC
	`, taskExecutionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var steps []*models.StepExecution
	for rows.Next() {
		s, err := scanStepExecutionRow(rows)
		if err != nil {
			return nil, err
		}
		steps = append(steps, s)
	}
	return steps, rows.Err()
}

// ── ExecutionEvent ────────────────────────────────────────────────────────────

// nextEventSeq returns the next sequence number for an execution.
func (r *ExecutionRepository) nextEventSeq(ctx context.Context, taskExecutionID string) (int, error) {
	var seq int
	err := r.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) + 1 FROM execution_events WHERE task_execution_id = $1
	`, taskExecutionID).Scan(&seq)
	return seq, err
}

// AppendEvent inserts an execution event. For tool_call events, tool_call_id
// enables idempotent dispatch — duplicate IDs return the existing event.
func (r *ExecutionRepository) AppendEvent(
	ctx context.Context,
	taskExecutionID string,
	stepExecutionID *string,
	eventType string,
	toolName *string,
	toolArgs json.RawMessage,
	toolResult json.RawMessage,
	toolCallID *string,
	message *string,
	success *bool,
	durationMS *int,
) (*models.ExecutionEvent, error) {
	id := uuid.New().String()
	now := time.Now()

	seq, err := r.nextEventSeq(ctx, taskExecutionID)
	if err != nil {
		return nil, fmt.Errorf("nextEventSeq: %w", err)
	}

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO execution_events
			(id, task_execution_id, step_execution_id, seq, event_type,
			 tool_name, tool_args, tool_result, tool_call_id,
			 message, success, duration_ms, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (task_execution_id, tool_call_id)
		WHERE tool_call_id IS NOT NULL
		DO UPDATE
			SET tool_result = EXCLUDED.tool_result,
			    success     = EXCLUDED.success,
			    duration_ms = EXCLUDED.duration_ms
		RETURNING id, task_execution_id, step_execution_id, seq, event_type,
		          tool_name, tool_args, tool_result, tool_call_id,
		          message, success, duration_ms, created_at
	`, id, taskExecutionID, stepExecutionID, seq, eventType,
		toolName, nullableJSON(toolArgs), nullableJSON(toolResult), toolCallID,
		message, success, durationMS, now)

	return scanEvent(row)
}

// GetEventByToolCallID returns an existing event for a given tool_call_id
// (used for idempotent dispatch — if it exists, return the cached result).
func (r *ExecutionRepository) GetEventByToolCallID(ctx context.Context, taskExecutionID, toolCallID string) (*models.ExecutionEvent, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, step_execution_id, seq, event_type,
		       tool_name, tool_args, tool_result, tool_call_id,
		       message, success, duration_ms, created_at
		FROM execution_events
		WHERE task_execution_id = $1 AND tool_call_id = $2
	`, taskExecutionID, toolCallID)
	return scanEvent(row)
}

// ListEvents returns all events for an execution in seq order.
func (r *ExecutionRepository) ListEvents(ctx context.Context, taskExecutionID string) ([]*models.ExecutionEvent, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, task_execution_id, step_execution_id, seq, event_type,
		       tool_name, tool_args, tool_result, tool_call_id,
		       message, success, duration_ms, created_at
		FROM execution_events
		WHERE task_execution_id = $1
		ORDER BY seq ASC
	`, taskExecutionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []*models.ExecutionEvent
	for rows.Next() {
		e, err := scanEventRow(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// ── CodeDiff ──────────────────────────────────────────────────────────────────

// CreateDiff inserts a code diff computed by Go.
// stepExecutionID may be empty when called from the tool dispatch handler
// before a step_execution row is known.
func (r *ExecutionRepository) CreateDiff(
	ctx context.Context,
	taskExecutionID, stepExecutionID, filePath, operation string,
	oldPath *string,
	diffUnified *string,
	linesAdded, linesRemoved int,
) (*models.CodeDiff, error) {
	id := uuid.New().String()
	now := time.Now()

	var stepExecIDArg interface{}
	if stepExecutionID != "" {
		stepExecIDArg = stepExecutionID
	}

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO code_diffs
			(id, task_execution_id, step_execution_id, file_path, operation,
			 old_path, diff_unified, lines_added, lines_removed, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING id, task_execution_id, step_execution_id, file_path, operation,
		          old_path, diff_unified, lines_added, lines_removed, created_at
	`, id, taskExecutionID, stepExecIDArg, filePath, operation,
		oldPath, diffUnified, linesAdded, linesRemoved, now)

	return scanDiff(row)
}

// ListDiffs returns all diffs for an execution.
func (r *ExecutionRepository) ListDiffs(ctx context.Context, taskExecutionID string) ([]*models.CodeDiff, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, task_execution_id, step_execution_id, file_path, operation,
		       old_path, diff_unified, lines_added, lines_removed, created_at
		FROM code_diffs
		WHERE task_execution_id = $1
		ORDER BY created_at ASC
	`, taskExecutionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var diffs []*models.CodeDiff
	for rows.Next() {
		d, err := scanDiffRow(rows)
		if err != nil {
			return nil, err
		}
		diffs = append(diffs, d)
	}
	return diffs, rows.Err()
}

// ── ExecutionCheckpoint ───────────────────────────────────────────────────────

// SaveCheckpoint upserts a checkpoint after a completed step.
func (r *ExecutionRepository) SaveCheckpoint(
	ctx context.Context,
	taskExecutionID, stepStableID string,
	stepOrder int,
	modifiedFiles, createdFiles, deletedFiles []string,
) (*models.ExecutionCheckpoint, error) {
	id := uuid.New().String()
	now := time.Now()

	if modifiedFiles == nil {
		modifiedFiles = []string{}
	}
	if createdFiles == nil {
		createdFiles = []string{}
	}
	if deletedFiles == nil {
		deletedFiles = []string{}
	}

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO execution_checkpoints
			(id, task_execution_id, step_stable_id, step_order,
			 modified_files, created_files, deleted_files, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (task_execution_id, step_stable_id) DO UPDATE
			SET modified_files = EXCLUDED.modified_files,
			    created_files  = EXCLUDED.created_files,
			    deleted_files  = EXCLUDED.deleted_files
		RETURNING id, task_execution_id, step_stable_id, step_order,
		          modified_files, created_files, deleted_files, created_at
	`, id, taskExecutionID, stepStableID, stepOrder,
		pq.Array(modifiedFiles), pq.Array(createdFiles), pq.Array(deletedFiles), now)

	return scanCheckpoint(row)
}

// GetLatestCheckpoint returns the most recently written checkpoint for an execution.
func (r *ExecutionRepository) GetLatestCheckpoint(ctx context.Context, taskExecutionID string) (*models.ExecutionCheckpoint, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, step_stable_id, step_order,
		       modified_files, created_files, deleted_files, created_at
		FROM execution_checkpoints
		WHERE task_execution_id = $1
		ORDER BY step_order DESC LIMIT 1
	`, taskExecutionID)
	return scanCheckpoint(row)
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanExecution(row *sql.Row) (*models.TaskExecution, error) {
	var e models.TaskExecution
	var currentStep sql.NullString
	var startedAt, completedAt sql.NullTime
	var errStr sql.NullString
	var execCtx []byte

	err := row.Scan(
		&e.ID, &e.WorkItemID, &e.WorkspaceID, &e.PlanID, &e.Status,
		&currentStep, &execCtx, &startedAt, &completedAt, &errStr,
		&e.CreatedAt, &e.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if currentStep.Valid {
		e.CurrentStepStableID = &currentStep.String
	}
	if errStr.Valid {
		e.Error = &errStr.String
	}
	if startedAt.Valid {
		e.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		e.CompletedAt = &completedAt.Time
	}
	e.ExecutionContext = json.RawMessage(execCtx)
	return &e, nil
}

func scanStepExecution(row *sql.Row) (*models.StepExecution, error) {
	var s models.StepExecution
	var startedAt, completedAt sql.NullTime
	var reasoning, deviation sql.NullString

	err := row.Scan(
		&s.ID, &s.TaskExecutionID, &s.StepStableID, &s.StepOrder,
		&s.Status, &startedAt, &completedAt, &reasoning, &deviation, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if startedAt.Valid {
		s.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		s.CompletedAt = &completedAt.Time
	}
	if reasoning.Valid {
		s.Reasoning = &reasoning.String
	}
	if deviation.Valid {
		s.DeviationNote = &deviation.String
	}
	return &s, nil
}

func scanStepExecutionRow(rows *sql.Rows) (*models.StepExecution, error) {
	var s models.StepExecution
	var startedAt, completedAt sql.NullTime
	var reasoning, deviation sql.NullString

	err := rows.Scan(
		&s.ID, &s.TaskExecutionID, &s.StepStableID, &s.StepOrder,
		&s.Status, &startedAt, &completedAt, &reasoning, &deviation, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if startedAt.Valid {
		s.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		s.CompletedAt = &completedAt.Time
	}
	if reasoning.Valid {
		s.Reasoning = &reasoning.String
	}
	if deviation.Valid {
		s.DeviationNote = &deviation.String
	}
	return &s, nil
}

func scanEvent(row *sql.Row) (*models.ExecutionEvent, error) {
	var e models.ExecutionEvent
	var stepExecID, toolName, toolCallID, msg sql.NullString
	var toolArgs, toolResult []byte
	var success sql.NullBool
	var durationMS sql.NullInt32

	err := row.Scan(
		&e.ID, &e.TaskExecutionID, &stepExecID, &e.Seq, &e.EventType,
		&toolName, &toolArgs, &toolResult, &toolCallID,
		&msg, &success, &durationMS, &e.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if stepExecID.Valid {
		e.StepExecutionID = &stepExecID.String
	}
	if toolName.Valid {
		e.ToolName = &toolName.String
	}
	if len(toolArgs) > 0 {
		e.ToolArgs = json.RawMessage(toolArgs)
	}
	if len(toolResult) > 0 {
		e.ToolResult = json.RawMessage(toolResult)
	}
	if toolCallID.Valid {
		e.ToolCallID = &toolCallID.String
	}
	if msg.Valid {
		e.Message = &msg.String
	}
	if success.Valid {
		v := success.Bool
		e.Success = &v
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		e.DurationMS = &n
	}
	return &e, nil
}

func scanEventRow(rows *sql.Rows) (*models.ExecutionEvent, error) {
	var e models.ExecutionEvent
	var stepExecID, toolName, toolCallID, msg sql.NullString
	var toolArgs, toolResult []byte
	var success sql.NullBool
	var durationMS sql.NullInt32

	err := rows.Scan(
		&e.ID, &e.TaskExecutionID, &stepExecID, &e.Seq, &e.EventType,
		&toolName, &toolArgs, &toolResult, &toolCallID,
		&msg, &success, &durationMS, &e.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if stepExecID.Valid {
		e.StepExecutionID = &stepExecID.String
	}
	if toolName.Valid {
		e.ToolName = &toolName.String
	}
	if len(toolArgs) > 0 {
		e.ToolArgs = json.RawMessage(toolArgs)
	}
	if len(toolResult) > 0 {
		e.ToolResult = json.RawMessage(toolResult)
	}
	if toolCallID.Valid {
		e.ToolCallID = &toolCallID.String
	}
	if msg.Valid {
		e.Message = &msg.String
	}
	if success.Valid {
		v := success.Bool
		e.Success = &v
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		e.DurationMS = &n
	}
	return &e, nil
}

func scanDiff(row *sql.Row) (*models.CodeDiff, error) {
	var d models.CodeDiff
	var oldPath, diffUnified, stepExecID sql.NullString

	err := row.Scan(
		&d.ID, &d.TaskExecutionID, &stepExecID, &d.FilePath, &d.Operation,
		&oldPath, &diffUnified, &d.LinesAdded, &d.LinesRemoved, &d.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if stepExecID.Valid {
		d.StepExecutionID = stepExecID.String
	}
	if oldPath.Valid {
		d.OldPath = &oldPath.String
	}
	if diffUnified.Valid {
		d.DiffUnified = &diffUnified.String
	}
	return &d, nil
}

func scanDiffRow(rows *sql.Rows) (*models.CodeDiff, error) {
	var d models.CodeDiff
	var oldPath, diffUnified, stepExecID sql.NullString

	err := rows.Scan(
		&d.ID, &d.TaskExecutionID, &stepExecID, &d.FilePath, &d.Operation,
		&oldPath, &diffUnified, &d.LinesAdded, &d.LinesRemoved, &d.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if stepExecID.Valid {
		d.StepExecutionID = stepExecID.String
	}
	if oldPath.Valid {
		d.OldPath = &oldPath.String
	}
	if diffUnified.Valid {
		d.DiffUnified = &diffUnified.String
	}
	return &d, nil
}

func scanCheckpoint(row *sql.Row) (*models.ExecutionCheckpoint, error) {
	var c models.ExecutionCheckpoint
	var modified, created, deleted pq.StringArray

	err := row.Scan(
		&c.ID, &c.TaskExecutionID, &c.StepStableID, &c.StepOrder,
		&modified, &created, &deleted, &c.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	c.ModifiedFiles = []string(modified)
	c.CreatedFiles = []string(created)
	c.DeletedFiles = []string(deleted)
	return &c, nil
}
