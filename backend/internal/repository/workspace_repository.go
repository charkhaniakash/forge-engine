package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
	"github.com/lib/pq"
)

// insertLogWithSeq allocates the next per-workspace execution_logs.seq and runs
// the caller's INSERT under a transaction-scoped advisory lock keyed on the
// workspace. The lock serializes seq allocation across concurrent execs on the
// same workspace (e.g. a browser terminal running alongside a repair pass), so
// two inserts can never pick the same seq — no unique-violation, no Postgres
// error-log noise. `insert` receives the tx and the allocated seq and must
// return the RETURNING row.
func (r *WorkspaceRepository) insertLogWithSeq(
	ctx context.Context,
	workspaceID string,
	insert func(tx *sql.Tx, seq int) *sql.Row,
) (*models.ExecutionLog, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, workspaceID); err != nil {
		return nil, fmt.Errorf("advisory lock: %w", err)
	}

	var seq int
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) + 1 FROM execution_logs WHERE workspace_id = $1`,
		workspaceID).Scan(&seq); err != nil {
		return nil, fmt.Errorf("next seq: %w", err)
	}

	log, err := scanLog(insert(tx, seq))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return log, nil
}

// WorkspaceRepository handles all persistence for workspaces and execution_logs.
// Go owns every status transition — no external caller may mutate status directly.
type WorkspaceRepository struct {
	db *sql.DB
}

func NewWorkspaceRepository(db *sql.DB) *WorkspaceRepository {
	return &WorkspaceRepository{db: db}
}

// ── Workspace CRUD ────────────────────────────────────────────────────────────

// Create inserts a new workspace row in 'provisioning' status and returns it.
func (r *WorkspaceRepository) Create(
	ctx context.Context,
	workItemID, repoID, commitSHA string,
	image string,
	cpuLimit string,
	memoryLimitMB, pidLimit, timeoutSeconds int,
) (*models.Workspace, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO workspaces
			(id, work_item_id, repo_id, commit_sha, driver, image,
			 cpu_limit, memory_limit_mb, pid_limit, timeout_seconds,
			 status, created_at, updated_at)
		VALUES
			($1, $2, $3, $4, 'docker', $5, $6, $7, $8, $9, 'provisioning', $10, $10)
		RETURNING
			id, work_item_id, repo_id, commit_sha, driver,
			container_id, container_name, image,
			cpu_limit, memory_limit_mb, pid_limit, timeout_seconds,
			status, started_at, ready_at, destroyed_at, error,
			created_at, updated_at
	`, id, workItemID, repoID, commitSHA, image,
		cpuLimit, memoryLimitMB, pidLimit, timeoutSeconds, now)

	return scanWorkspace(row)
}

// GetByID returns a workspace by UUID.
func (r *WorkspaceRepository) GetByID(ctx context.Context, id string) (*models.Workspace, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, repo_id, commit_sha, driver,
		       container_id, container_name, image,
		       cpu_limit, memory_limit_mb, pid_limit, timeout_seconds,
		       status, started_at, ready_at, destroyed_at, error,
		       created_at, updated_at
		FROM workspaces WHERE id = $1
	`, id)
	return scanWorkspace(row)
}

// GetByWorkItemID returns the most recent workspace for a work item.
func (r *WorkspaceRepository) GetByWorkItemID(ctx context.Context, workItemID string) (*models.Workspace, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, repo_id, commit_sha, driver,
		       container_id, container_name, image,
		       cpu_limit, memory_limit_mb, pid_limit, timeout_seconds,
		       status, started_at, ready_at, destroyed_at, error,
		       created_at, updated_at
		FROM workspaces
		WHERE work_item_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`, workItemID)
	return scanWorkspace(row)
}

// ListLive returns all workspaces not yet destroyed (used by the reaper).
func (r *WorkspaceRepository) ListLive(ctx context.Context) ([]*models.Workspace, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, work_item_id, repo_id, commit_sha, driver,
		       container_id, container_name, image,
		       cpu_limit, memory_limit_mb, pid_limit, timeout_seconds,
		       status, started_at, ready_at, destroyed_at, error,
		       created_at, updated_at
		FROM workspaces
		WHERE status NOT IN ('destroyed', 'destroying')
		ORDER BY created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var workspaces []*models.Workspace
	for rows.Next() {
		ws, err := scanWorkspaceRow(rows)
		if err != nil {
			return nil, err
		}
		workspaces = append(workspaces, ws)
	}
	return workspaces, rows.Err()
}

// ── Status transitions ────────────────────────────────────────────────────────

// SetContainerID stores the opaque driver handle after container creation.
func (r *WorkspaceRepository) SetContainerID(ctx context.Context, id, containerID, containerName string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE workspaces
		SET container_id = $2, container_name = $3,
		    started_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, containerID, containerName)
	return err
}

// MarkReady transitions status to 'ready' after the repo is cloned and checked out.
func (r *WorkspaceRepository) MarkReady(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE workspaces
		SET status = 'ready', ready_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

// MarkFailed transitions status to 'failed' with an error message.
func (r *WorkspaceRepository) MarkFailed(ctx context.Context, id, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE workspaces
		SET status = 'failed', error = $2, updated_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// MarkDestroying transitions status to 'destroying'.
func (r *WorkspaceRepository) MarkDestroying(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE workspaces
		SET status = 'destroying', updated_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

// MarkDestroyed transitions status to 'destroyed'.
func (r *WorkspaceRepository) MarkDestroyed(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE workspaces
		SET status = 'destroyed', destroyed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

// ── Execution logs ────────────────────────────────────────────────────────────

// LogLifecycle inserts a lifecycle event into execution_logs. seq allocation is
// serialized per workspace by insertLogWithSeq's advisory lock.
func (r *WorkspaceRepository) LogLifecycle(
	ctx context.Context,
	workspaceID, lifecycleEvent, message string,
) (*models.ExecutionLog, error) {
	now := time.Now()
	return r.insertLogWithSeq(ctx, workspaceID, func(tx *sql.Tx, seq int) *sql.Row {
		return tx.QueryRowContext(ctx, `
			INSERT INTO execution_logs
				(id, workspace_id, seq, event_type, lifecycle_event, message, created_at)
			VALUES ($1, $2, $3, 'lifecycle', $4, $5, $6)
			RETURNING id, workspace_id, seq, event_type, lifecycle_event,
			          command, working_dir, exit_code, timed_out, timeout_seconds,
			          duration_ms, stdout, stderr, message,
			          started_at, completed_at, created_at
		`, uuid.New().String(), workspaceID, seq, lifecycleEvent, message, now)
	})
}

// LogCommandStart inserts a command event before execution begins.
// Returns the log so the caller can update it on completion.
func (r *WorkspaceRepository) LogCommandStart(
	ctx context.Context,
	workspaceID string,
	command []string,
	workingDir *string,
	timeoutSeconds int,
) (*models.ExecutionLog, error) {
	now := time.Now()
	return r.insertLogWithSeq(ctx, workspaceID, func(tx *sql.Tx, seq int) *sql.Row {
		return tx.QueryRowContext(ctx, `
			INSERT INTO execution_logs
				(id, workspace_id, seq, event_type, command, working_dir,
				 timeout_seconds, started_at, created_at)
			VALUES ($1, $2, $3, 'command', $4, $5, $6, $7, $7)
			RETURNING id, workspace_id, seq, event_type, lifecycle_event,
			          command, working_dir, exit_code, timed_out, timeout_seconds,
			          duration_ms, stdout, stderr, message,
			          started_at, completed_at, created_at
		`, uuid.New().String(), workspaceID, seq, pq.Array(command), workingDir, timeoutSeconds, now)
	})
}

// LogCommandComplete updates a command log with its results.
func (r *WorkspaceRepository) LogCommandComplete(
	ctx context.Context,
	logID string,
	exitCode int,
	stdout, stderr string,
	timedOut bool,
	durationMS int,
) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE execution_logs
		SET exit_code    = $2,
		    stdout       = $3,
		    stderr       = $4,
		    timed_out    = $5,
		    duration_ms  = $6,
		    completed_at = NOW()
		WHERE id = $1
	`, logID, exitCode, stdout, stderr, timedOut, durationMS)
	return err
}

// ListLogs returns all execution logs for a workspace in seq order.
func (r *WorkspaceRepository) ListLogs(ctx context.Context, workspaceID string) ([]*models.ExecutionLog, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, workspace_id, seq, event_type, lifecycle_event,
		       command, working_dir, exit_code, timed_out, timeout_seconds,
		       duration_ms, stdout, stderr, message,
		       started_at, completed_at, created_at
		FROM execution_logs
		WHERE workspace_id = $1
		ORDER BY seq ASC
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []*models.ExecutionLog
	for rows.Next() {
		l, err := scanLogRow(rows)
		if err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, rows.Err()
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanWorkspace(row *sql.Row) (*models.Workspace, error) {
	var ws models.Workspace
	var containerID, containerName, errStr sql.NullString
	var startedAt, readyAt, destroyedAt sql.NullTime

	err := row.Scan(
		&ws.ID, &ws.WorkItemID, &ws.RepoID, &ws.CommitSHA, &ws.Driver,
		&containerID, &containerName, &ws.Image,
		&ws.CPULimit, &ws.MemoryLimitMB, &ws.PIDLimit, &ws.TimeoutSeconds,
		&ws.Status, &startedAt, &readyAt, &destroyedAt, &errStr,
		&ws.CreatedAt, &ws.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if containerID.Valid {
		ws.ContainerID = &containerID.String
	}
	if containerName.Valid {
		ws.ContainerName = &containerName.String
	}
	if errStr.Valid {
		ws.Error = &errStr.String
	}
	if startedAt.Valid {
		ws.StartedAt = &startedAt.Time
	}
	if readyAt.Valid {
		ws.ReadyAt = &readyAt.Time
	}
	if destroyedAt.Valid {
		ws.DestroyedAt = &destroyedAt.Time
	}
	return &ws, nil
}

func scanWorkspaceRow(rows *sql.Rows) (*models.Workspace, error) {
	var ws models.Workspace
	var containerID, containerName, errStr sql.NullString
	var startedAt, readyAt, destroyedAt sql.NullTime

	err := rows.Scan(
		&ws.ID, &ws.WorkItemID, &ws.RepoID, &ws.CommitSHA, &ws.Driver,
		&containerID, &containerName, &ws.Image,
		&ws.CPULimit, &ws.MemoryLimitMB, &ws.PIDLimit, &ws.TimeoutSeconds,
		&ws.Status, &startedAt, &readyAt, &destroyedAt, &errStr,
		&ws.CreatedAt, &ws.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if containerID.Valid {
		ws.ContainerID = &containerID.String
	}
	if containerName.Valid {
		ws.ContainerName = &containerName.String
	}
	if errStr.Valid {
		ws.Error = &errStr.String
	}
	if startedAt.Valid {
		ws.StartedAt = &startedAt.Time
	}
	if readyAt.Valid {
		ws.ReadyAt = &readyAt.Time
	}
	if destroyedAt.Valid {
		ws.DestroyedAt = &destroyedAt.Time
	}
	return &ws, nil
}

func scanLog(row *sql.Row) (*models.ExecutionLog, error) {
	var l models.ExecutionLog
	var lifecycleEvent, workingDir, msg sql.NullString
	var exitCode, timeoutSec, durationMS sql.NullInt32
	var startedAt, completedAt sql.NullTime
	var cmdArr pq.StringArray

	err := row.Scan(
		&l.ID, &l.WorkspaceID, &l.Seq, &l.EventType, &lifecycleEvent,
		&cmdArr, &workingDir, &exitCode, &l.TimedOut, &timeoutSec,
		&durationMS, &l.Stdout, &l.Stderr, &msg,
		&startedAt, &completedAt, &l.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if lifecycleEvent.Valid {
		l.LifecycleEvent = &lifecycleEvent.String
	}
	if len(cmdArr) > 0 {
		l.Command = []string(cmdArr)
	}
	if workingDir.Valid {
		l.WorkingDir = &workingDir.String
	}
	if exitCode.Valid {
		n := int(exitCode.Int32)
		l.ExitCode = &n
	}
	if timeoutSec.Valid {
		n := int(timeoutSec.Int32)
		l.TimeoutSeconds = &n
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		l.DurationMS = &n
	}
	if msg.Valid {
		l.Message = &msg.String
	}
	if startedAt.Valid {
		l.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		l.CompletedAt = &completedAt.Time
	}
	return &l, nil
}

func scanLogRow(rows *sql.Rows) (*models.ExecutionLog, error) {
	var l models.ExecutionLog
	var lifecycleEvent, workingDir, msg sql.NullString
	var exitCode, timeoutSec, durationMS sql.NullInt32
	var startedAt, completedAt sql.NullTime
	var cmdArr pq.StringArray

	err := rows.Scan(
		&l.ID, &l.WorkspaceID, &l.Seq, &l.EventType, &lifecycleEvent,
		&cmdArr, &workingDir, &exitCode, &l.TimedOut, &timeoutSec,
		&durationMS, &l.Stdout, &l.Stderr, &msg,
		&startedAt, &completedAt, &l.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if lifecycleEvent.Valid {
		l.LifecycleEvent = &lifecycleEvent.String
	}
	if len(cmdArr) > 0 {
		l.Command = []string(cmdArr)
	}
	if workingDir.Valid {
		l.WorkingDir = &workingDir.String
	}
	if exitCode.Valid {
		n := int(exitCode.Int32)
		l.ExitCode = &n
	}
	if timeoutSec.Valid {
		n := int(timeoutSec.Int32)
		l.TimeoutSeconds = &n
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		l.DurationMS = &n
	}
	if msg.Valid {
		l.Message = &msg.String
	}
	if startedAt.Valid {
		l.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		l.CompletedAt = &completedAt.Time
	}
	return &l, nil
}
