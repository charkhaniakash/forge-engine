package validation

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

// ValidationRepository handles persistence for the three validation tables.
// Phase 9 never reads these tables directly — it calls GetRunWithFullResult.
type ValidationRepository struct {
	db *sql.DB
}

func NewValidationRepository(db *sql.DB) *ValidationRepository {
	return &ValidationRepository{db: db}
}

// ── ValidationRun ─────────────────────────────────────────────────────────────

func (r *ValidationRepository) CreateRun(
	ctx context.Context,
	taskExecutionID, workspaceID string,
	detection *DetectionResult,
	runType string,
) (*models.ValidationRun, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO validation_runs
			(id, task_execution_id, workspace_id, stack, language, framework,
			 package_manager, profile_id, run_type, status, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10)
		RETURNING id, task_execution_id, workspace_id, stack, language, framework,
		          package_manager, profile_id, run_type, baseline_run_id,
		          baseline_enabled, status, overall_result, error,
		          started_at, completed_at, created_at, updated_at
	`, id, taskExecutionID, workspaceID,
		detection.Language, detection.Language, detection.Framework,
		detection.PackageManager, detection.ProfileID, runType, now)

	return scanRun(row)
}

func (r *ValidationRepository) GetRun(ctx context.Context, id string) (*models.ValidationRun, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, workspace_id, stack, language, framework,
		       package_manager, profile_id, run_type, baseline_run_id,
		       baseline_enabled, status, overall_result, error,
		       started_at, completed_at, created_at, updated_at
		FROM validation_runs WHERE id = $1
	`, id)
	return scanRun(row)
}

func (r *ValidationRepository) GetLatestForTaskExecution(ctx context.Context, taskExecID string) (*models.ValidationRun, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, task_execution_id, workspace_id, stack, language, framework,
		       package_manager, profile_id, run_type, baseline_run_id,
		       baseline_enabled, status, overall_result, error,
		       started_at, completed_at, created_at, updated_at
		FROM validation_runs
		WHERE task_execution_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, taskExecID)
	return scanRun(row)
}

func (r *ValidationRepository) MarkRunning(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_runs
		SET status = 'running', started_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id)
	return err
}

func (r *ValidationRepository) MarkCompleted(ctx context.Context, id, overallResult string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_runs
		SET status = 'passed', overall_result = $2,
		    completed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, overallResult)
	return err
}

func (r *ValidationRepository) MarkFailed(ctx context.Context, id, overallResult string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_runs
		SET status = 'failed', overall_result = $2,
		    completed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, overallResult)
	return err
}

func (r *ValidationRepository) MarkError(ctx context.Context, id, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_runs
		SET status = 'error', error = $2, completed_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// ── ValidationStage ───────────────────────────────────────────────────────────

func (r *ValidationRepository) CreateStage(
	ctx context.Context,
	runID, stage string,
	seqNum int,
	command []string,
) (*models.ValidationStage, error) {
	id := uuid.New().String()
	now := time.Now()

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO validation_stages
			(id, validation_run_id, stage, sequence_number, status, command, created_at)
		VALUES ($1,$2,$3,$4,'pending',$5,$6)
		RETURNING id, validation_run_id, stage, sequence_number, status,
		          command, exit_code, stdout, stderr, combined_output,
		          duration_ms, started_at, completed_at, created_at
	`, id, runID, stage, seqNum, pq.Array(command), now)
	return scanStage(row)
}

func (r *ValidationRepository) MarkStageRunning(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_stages SET status='running', started_at=NOW() WHERE id=$1
	`, id)
	return err
}

func (r *ValidationRepository) CompleteStage(
	ctx context.Context,
	id string,
	exitCode int,
	stdout, stderr, combined string,
	durationMS int,
	passed bool,
) error {
	status := "passed"
	if !passed {
		status = "failed"
	}
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_stages
		SET status=$2, exit_code=$3, stdout=$4, stderr=$5, combined_output=$6,
		    duration_ms=$7, completed_at=NOW()
		WHERE id=$1
	`, id, status, exitCode, stdout, stderr, combined, durationMS)
	return err
}

func (r *ValidationRepository) SkipStage(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE validation_stages SET status='skipped', completed_at=NOW() WHERE id=$1
	`, id)
	return err
}

func (r *ValidationRepository) ListStages(ctx context.Context, runID string) ([]*models.ValidationStage, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, validation_run_id, stage, sequence_number, status,
		       command, exit_code, stdout, stderr, combined_output,
		       duration_ms, started_at, completed_at, created_at
		FROM validation_stages
		WHERE validation_run_id=$1
		ORDER BY sequence_number ASC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var stages []*models.ValidationStage
	for rows.Next() {
		s, err := scanStageRow(rows)
		if err != nil {
			return nil, err
		}
		stages = append(stages, s)
	}
	return stages, rows.Err()
}

// ── ValidationDiagnostic ─────────────────────────────────────────────────────

// InsertDiagnostics bulk-inserts parsed diagnostics for a stage.
func (r *ValidationRepository) InsertDiagnostics(
	ctx context.Context,
	runID, stage string,
	diags []AgentDiagnostic,
) error {
	if len(diags) == 0 {
		return nil
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	for _, d := range diags {
		id := uuid.New().String()
		_, err := tx.ExecContext(ctx, `
			INSERT INTO validation_diagnostics
				(id, validation_run_id, stage, severity, category,
				 file_path, line_number, column_number, symbol_name,
				 message, raw_output, tool, origin, confidence,
				 repair_category, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
		`, id, runID, stage, d.Severity, d.Category,
			nullStr(d.FilePath), nullInt(d.LineNumber), nullInt(d.ColumnNumber),
			nullStr(d.SymbolName), d.Message, nullStr(d.RawOutput),
			d.Tool, d.Origin, d.Confidence, nullStr(d.RepairCategory))
		if err != nil {
			return fmt.Errorf("insert diagnostic: %w", err)
		}
	}
	return tx.Commit()
}

func (r *ValidationRepository) ListDiagnostics(ctx context.Context, runID string) ([]*models.ValidationDiagnostic, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, validation_run_id, stage, severity, category,
		       file_path, line_number, column_number, symbol_name,
		       message, raw_output, tool, origin, confidence,
		       repair_category, created_at
		FROM validation_diagnostics
		WHERE validation_run_id=$1
		ORDER BY created_at ASC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var diags []*models.ValidationDiagnostic
	for rows.Next() {
		d, err := scanDiagRow(rows)
		if err != nil {
			return nil, err
		}
		diags = append(diags, d)
	}
	return diags, rows.Err()
}

// ── Canonical result (Phase 9 interface) ─────────────────────────────────────

// GetRunWithFullResult assembles the canonical ValidationRun domain object
// that Phase 9 consumes. Phase 9 never reads the raw tables directly.
func (r *ValidationRepository) GetRunWithFullResult(ctx context.Context, runID string) (*models.ValidationRun, error) {
	run, err := r.GetRun(ctx, runID)
	if err != nil {
		return nil, err
	}

	stages, err := r.ListStages(ctx, runID)
	if err != nil {
		return nil, err
	}
	run.Stages = stages

	diags, err := r.ListDiagnostics(ctx, runID)
	if err != nil {
		return nil, err
	}
	run.Diagnostics = diags
	run.Summary = computeSummary(stages, diags)

	return run, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func computeSummary(stages []*models.ValidationStage, diags []*models.ValidationDiagnostic) *models.ValidationSummary {
	s := &models.ValidationSummary{}
	for _, d := range diags {
		switch d.Severity {
		case "error":
			s.TotalErrors++
		case "warning":
			s.TotalWarnings++
		}
		if d.RepairCategory != nil {
			switch *d.RepairCategory {
			case "auto_fixable":
				s.AutoFixableCount++
			case "needs_human":
				s.NeedsHumanCount++
			}
		}
	}
	for _, st := range stages {
		passed := st.Status == "passed" || st.Status == "skipped"
		switch st.Stage {
		case "build":
			s.BuildPassed = passed
		case "test":
			s.TestsPassed = passed
		case "lint":
			s.LintPassed = passed
		}
	}
	return s
}

func scanRun(row *sql.Row) (*models.ValidationRun, error) {
	var v models.ValidationRun
	var baselineID, overallResult, errStr sql.NullString
	var startedAt, completedAt sql.NullTime

	err := row.Scan(
		&v.ID, &v.TaskExecutionID, &v.WorkspaceID,
		&v.Stack, &v.Language, &v.Framework, &v.PackageManager,
		&v.ProfileID, &v.RunType, &baselineID, &v.BaselineEnabled,
		&v.Status, &overallResult, &errStr,
		&startedAt, &completedAt, &v.CreatedAt, &v.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if baselineID.Valid {
		v.BaselineRunID = &baselineID.String
	}
	if overallResult.Valid {
		v.OverallResult = &overallResult.String
	}
	if errStr.Valid {
		v.Error = &errStr.String
	}
	if startedAt.Valid {
		v.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		v.CompletedAt = &completedAt.Time
	}
	return &v, nil
}

func scanStage(row *sql.Row) (*models.ValidationStage, error) {
	var s models.ValidationStage
	var exitCode sql.NullInt32
	var stdout, stderr, combined sql.NullString
	var durationMS sql.NullInt32
	var startedAt, completedAt sql.NullTime
	var cmdArr pq.StringArray

	err := row.Scan(
		&s.ID, &s.ValidationRunID, &s.Stage, &s.SequenceNumber, &s.Status,
		&cmdArr, &exitCode, &stdout, &stderr, &combined,
		&durationMS, &startedAt, &completedAt, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if len(cmdArr) > 0 {
		s.Command = []string(cmdArr)
	}
	if exitCode.Valid {
		n := int(exitCode.Int32)
		s.ExitCode = &n
	}
	if stdout.Valid {
		s.Stdout = &stdout.String
	}
	if stderr.Valid {
		s.Stderr = &stderr.String
	}
	if combined.Valid {
		s.CombinedOutput = &combined.String
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		s.DurationMS = &n
	}
	if startedAt.Valid {
		s.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		s.CompletedAt = &completedAt.Time
	}
	return &s, nil
}

func scanStageRow(rows *sql.Rows) (*models.ValidationStage, error) {
	var s models.ValidationStage
	var exitCode sql.NullInt32
	var stdout, stderr, combined sql.NullString
	var durationMS sql.NullInt32
	var startedAt, completedAt sql.NullTime
	var cmdArr pq.StringArray

	err := rows.Scan(
		&s.ID, &s.ValidationRunID, &s.Stage, &s.SequenceNumber, &s.Status,
		&cmdArr, &exitCode, &stdout, &stderr, &combined,
		&durationMS, &startedAt, &completedAt, &s.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if len(cmdArr) > 0 {
		s.Command = []string(cmdArr)
	}
	if exitCode.Valid {
		n := int(exitCode.Int32)
		s.ExitCode = &n
	}
	if stdout.Valid {
		s.Stdout = &stdout.String
	}
	if stderr.Valid {
		s.Stderr = &stderr.String
	}
	if combined.Valid {
		s.CombinedOutput = &combined.String
	}
	if durationMS.Valid {
		n := int(durationMS.Int32)
		s.DurationMS = &n
	}
	if startedAt.Valid {
		s.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		s.CompletedAt = &completedAt.Time
	}
	return &s, nil
}

func scanDiagRow(rows *sql.Rows) (*models.ValidationDiagnostic, error) {
	var d models.ValidationDiagnostic
	var filePath, symbolName, rawOutput, repairCategory sql.NullString
	var lineNum, colNum sql.NullInt32

	err := rows.Scan(
		&d.ID, &d.ValidationRunID, &d.Stage, &d.Severity, &d.Category,
		&filePath, &lineNum, &colNum, &symbolName,
		&d.Message, &rawOutput, &d.Tool, &d.Origin, &d.Confidence,
		&repairCategory, &d.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if filePath.Valid {
		d.FilePath = &filePath.String
	}
	if lineNum.Valid {
		n := int(lineNum.Int32)
		d.LineNumber = &n
	}
	if colNum.Valid {
		n := int(colNum.Int32)
		d.ColumnNumber = &n
	}
	if symbolName.Valid {
		d.SymbolName = &symbolName.String
	}
	if rawOutput.Valid {
		d.RawOutput = &rawOutput.String
	}
	if repairCategory.Valid {
		d.RepairCategory = &repairCategory.String
	}
	return &d, nil
}

// ── JSON helpers for agent client ─────────────────────────────────────────────

// AgentDiagnostic mirrors the JSON returned by POST /v1/agent/parse-stage.
type AgentDiagnostic struct {
	Severity       string  `json:"severity"`
	Category       string  `json:"category"`
	FilePath       string  `json:"file_path,omitempty"`
	LineNumber     int     `json:"line_number,omitempty"`
	ColumnNumber   int     `json:"column_number,omitempty"`
	SymbolName     string  `json:"symbol_name,omitempty"`
	Message        string  `json:"message"`
	RawOutput      string  `json:"raw_output,omitempty"`
	Tool           string  `json:"tool"`
	Origin         string  `json:"origin"`
	Confidence     float32 `json:"confidence"`
	RepairCategory string  `json:"repair_category,omitempty"`
}

// AgentParseResponse is what POST /v1/agent/parse-stage returns.
type AgentParseResponse struct {
	Diagnostics        []AgentDiagnostic `json:"diagnostics"`
	StagePassed        bool              `json:"stage_passed"`
	ErrorCount         int               `json:"error_count"`
	WarningCount       int               `json:"warning_count"`
	// FailureOrigin classifies whether the failure is "code", "environment",
	// or "unknown". Only meaningful when StagePassed=false.
	FailureOrigin      string            `json:"failure_origin,omitempty"`
	// FailureExplanation is a human-readable description of why the stage
	// failed and what category of failure it is.
	FailureExplanation string            `json:"failure_explanation,omitempty"`
}

// ── null helpers ──────────────────────────────────────────────────────────────

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int) interface{} {
	if n == 0 {
		return nil
	}
	return n
}

// Silence unused import warning for json
var _ = json.Marshal
