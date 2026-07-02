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

// WorkItemRepository handles all persistence for work_items and plans.
// Go owns every status transition — no external caller may mutate status directly.
type WorkItemRepository struct {
	db *sql.DB
}

func NewWorkItemRepository(db *sql.DB) *WorkItemRepository {
	return &WorkItemRepository{db: db}
}

// ── WorkItem CRUD ─────────────────────────────────────────────────────────────

// Create inserts a new work item in 'draft' status and returns it.
func (r *WorkItemRepository) Create(
	ctx context.Context,
	repoID, orgID, userID, intent string,
) (*models.WorkItem, error) {
	id := uuid.New().String()
	now := time.Now()
	defaultPolicy := json.RawMessage(`{"type":"always_require_human"}`)

	row := r.db.QueryRowContext(ctx, `
		INSERT INTO work_items
			(id, repo_id, org_id, user_id, type, intent, status,
			 approval_status, approval_policy, created_at, updated_at)
		VALUES
			($1, $2, $3, $4, 'task', $5, 'draft',
			 'pending_review', $6, $7, $7)
		RETURNING
			id, repo_id, org_id, user_id, parent_id, template_id, type,
			intent, status, approval_status, approval_policy, error,
			created_at, updated_at
	`, id, repoID, orgID, userID, intent, defaultPolicy, now)

	return scanWorkItem(row)
}

// GetByID returns a work item by UUID, scoped to the given org.
func (r *WorkItemRepository) GetByID(ctx context.Context, id, orgID string) (*models.WorkItem, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, repo_id, org_id, user_id, parent_id, template_id, type,
		       intent, status, approval_status, approval_policy, error,
		       created_at, updated_at
		FROM work_items
		WHERE id = $1 AND org_id = $2
	`, id, orgID)
	return scanWorkItem(row)
}

// TransitionToExecuting moves a work item from plan_approved → executing.
// Called by ExecutionHandlers when the orchestrator goroutine starts.
func (r *WorkItemRepository) TransitionToExecuting(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE work_items
		SET status = $2, updated_at = NOW()
		WHERE id = $1 AND status = $3
	`, id, models.WorkItemStatusExecuting, models.WorkItemStatusPlanApproved)
	return err
}

// GetByIDInternal returns a work item by UUID without org scoping.
// Only used by internal goroutines (e.g. the planning background goroutine).
// Never expose this to HTTP handlers.
func (r *WorkItemRepository) GetByIDInternal(ctx context.Context, id string) (*models.WorkItem, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, repo_id, org_id, user_id, parent_id, template_id, type,
		       intent, status, approval_status, approval_policy, error,
		       created_at, updated_at
		FROM work_items
		WHERE id = $1
	`, id)
	return scanWorkItem(row)
}

// ListForRepo returns work items for a repo, newest first, scoped to the org.
func (r *WorkItemRepository) ListForRepo(
	ctx context.Context,
	repoID, orgID string,
	limit, offset int,
) ([]*models.WorkItem, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, repo_id, org_id, user_id, parent_id, template_id, type,
		       intent, status, approval_status, approval_policy, error,
		       created_at, updated_at
		FROM work_items
		WHERE repo_id = $1 AND org_id = $2
		ORDER BY created_at DESC
		LIMIT $3 OFFSET $4
	`, repoID, orgID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []*models.WorkItem
	for rows.Next() {
		item, err := scanWorkItemRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// ── Status transitions (Go-owned state machine) ───────────────────────────────

// StartPlanning transitions status: draft → planning.
func (r *WorkItemRepository) StartPlanning(ctx context.Context, id string) error {
	return r.transition(ctx, id, models.WorkItemStatusPlanning,
		[]string{models.WorkItemStatusDraft})
}

// MarkPlanReady transitions status: planning → plan_ready.
func (r *WorkItemRepository) MarkPlanReady(ctx context.Context, id string) error {
	return r.transition(ctx, id, models.WorkItemStatusPlanReady,
		[]string{models.WorkItemStatusPlanning})
}

// MarkPlanningFailed transitions status: planning → planning_failed and stores error.
func (r *WorkItemRepository) MarkPlanningFailed(ctx context.Context, id, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE work_items
		SET status = $2, error = $3, updated_at = NOW()
		WHERE id = $1 AND status = $4
	`, id, models.WorkItemStatusPlanningFailed, errMsg, models.WorkItemStatusPlanning)
	return err
}

// Approve transitions approval_status → approved and status → plan_approved.
// Enforces the approval gate: only allowed when status = 'plan_ready'.
// Phase 5: always_require_human policy — explicit user action required.
func (r *WorkItemRepository) Approve(ctx context.Context, id, orgID string) (*models.WorkItem, error) {
	row := r.db.QueryRowContext(ctx, `
		UPDATE work_items
		SET approval_status = 'approved',
		    status          = $3,
		    updated_at      = NOW()
		WHERE id = $1
		  AND org_id = $2
		  AND status = $4
		RETURNING
			id, repo_id, org_id, user_id, parent_id, template_id, type,
			intent, status, approval_status, approval_policy, error,
			created_at, updated_at
	`, id, orgID,
		models.WorkItemStatusPlanApproved,
		models.WorkItemStatusPlanReady)
	return scanWorkItem(row)
}

// ResetForReplan transitions status back to planning and clears the error.
// Called when the user triggers a re-plan.
func (r *WorkItemRepository) ResetForReplan(ctx context.Context, id, orgID string) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE work_items
		SET status          = $3,
		    approval_status = 'pending_review',
		    error           = NULL,
		    updated_at      = NOW()
		WHERE id = $1
		  AND org_id = $2
		  AND status IN ($4, $5)
	`, id, orgID,
		models.WorkItemStatusPlanning,
		models.WorkItemStatusPlanReady,
		models.WorkItemStatusPlanningFailed)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("work item %s cannot be re-planned from its current status", id)
	}
	return nil
}

// Cancel transitions status to cancelled from any non-terminal state.
func (r *WorkItemRepository) Cancel(ctx context.Context, id, orgID string) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE work_items
		SET status = $3, updated_at = NOW()
		WHERE id = $1
		  AND org_id = $2
		  AND status NOT IN ($4, $5, $6)
	`, id, orgID,
		models.WorkItemStatusCancelled,
		models.WorkItemStatusDone,
		models.WorkItemStatusFailed,
		models.WorkItemStatusCancelled)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("work item %s is already in a terminal state", id)
	}
	return nil
}

// ResetApprovalAfterEdit resets approval_status to pending_review after a user-edited plan.
// Called whenever a new plan version is submitted via PUT .../plan.
func (r *WorkItemRepository) ResetApprovalAfterEdit(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE work_items
		SET approval_status = 'pending_review',
		    status          = $2,
		    updated_at      = NOW()
		WHERE id = $1
	`, id, models.WorkItemStatusPlanReady)
	return err
}

// transition is a helper for guarded single-step status changes.
func (r *WorkItemRepository) transition(
	ctx context.Context,
	id, newStatus string,
	allowedFrom []string,
) error {
	if len(allowedFrom) == 0 {
		return fmt.Errorf("no allowed source statuses specified")
	}

	// Build a parameterised IN clause.
	placeholders := make([]string, len(allowedFrom))
	args := []interface{}{id, newStatus}
	for i, s := range allowedFrom {
		placeholders[i] = fmt.Sprintf("$%d", len(args)+1)
		args = append(args, s)
	}

	query := fmt.Sprintf(`
		UPDATE work_items
		SET status = $2, updated_at = NOW()
		WHERE id = $1 AND status IN (%s)
	`, joinStrings(placeholders, ", "))

	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("work item %s could not transition to %s (invalid current status)", id, newStatus)
	}
	return nil
}

// ── Plan CRUD ─────────────────────────────────────────────────────────────────

// CreatePlan inserts a new plan version and deactivates any existing active plan.
// Returns the newly inserted plan.
func (r *WorkItemRepository) CreatePlan(
	ctx context.Context,
	workItemID string,
	planType, plannerID string,
	body json.RawMessage,
	createdBy string, // "agent" | "user_edit"
) (*models.Plan, error) {
	id := uuid.New().String()
	now := time.Now()

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Deactivate all existing active plans for this work item.
	if _, err = tx.ExecContext(ctx, `
		UPDATE plans SET is_active = FALSE
		WHERE work_item_id = $1 AND is_active = TRUE
	`, workItemID); err != nil {
		return nil, fmt.Errorf("deactivate old plans: %w", err)
	}

	// Get the next version number.
	var maxVer int
	if err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 0) FROM plans WHERE work_item_id = $1`,
		workItemID,
	).Scan(&maxVer); err != nil {
		return nil, fmt.Errorf("get max version: %w", err)
	}
	nextVer := maxVer + 1

	// Insert the new plan.
	row := tx.QueryRowContext(ctx, `
		INSERT INTO plans
			(id, work_item_id, version, schema_version, plan_type, planner_id,
			 body, is_active, created_by, created_at)
		VALUES
			($1, $2, $3, 'v1', $4, $5, $6, TRUE, $7, $8)
		RETURNING
			id, work_item_id, version, schema_version, plan_type, planner_id,
			body, is_active, created_by, created_at
	`, id, workItemID, nextVer, planType, plannerID, body, createdBy, now)

	plan, err := scanPlan(row)
	if err != nil {
		return nil, fmt.Errorf("scan plan: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return plan, nil
}

// GetActivePlan returns the currently active plan for a work item.
func (r *WorkItemRepository) GetActivePlan(ctx context.Context, workItemID string) (*models.Plan, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, version, schema_version, plan_type, planner_id,
		       body, is_active, created_by, created_at
		FROM plans
		WHERE work_item_id = $1 AND is_active = TRUE
	`, workItemID)
	return scanPlan(row)
}

// ListPlans returns all plan versions for a work item, newest first.
func (r *WorkItemRepository) ListPlans(ctx context.Context, workItemID string) ([]*models.Plan, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, work_item_id, version, schema_version, plan_type, planner_id,
		       body, is_active, created_by, created_at
		FROM plans
		WHERE work_item_id = $1
		ORDER BY version DESC
	`, workItemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var plans []*models.Plan
	for rows.Next() {
		p, err := scanPlanRow(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, p)
	}
	return plans, rows.Err()
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

func scanWorkItem(row *sql.Row) (*models.WorkItem, error) {
	var w models.WorkItem
	var parentID, templateID, errStr sql.NullString
	var policy []byte

	err := row.Scan(
		&w.ID, &w.RepoID, &w.OrgID, &w.UserID,
		&parentID, &templateID, &w.Type,
		&w.Intent, &w.Status, &w.ApprovalStatus, &policy, &errStr,
		&w.CreatedAt, &w.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if parentID.Valid {
		w.ParentID = &parentID.String
	}
	if templateID.Valid {
		w.TemplateID = &templateID.String
	}
	if errStr.Valid {
		w.Error = &errStr.String
	}
	w.ApprovalPolicy = json.RawMessage(policy)
	return &w, nil
}

func scanWorkItemRow(rows *sql.Rows) (*models.WorkItem, error) {
	var w models.WorkItem
	var parentID, templateID, errStr sql.NullString
	var policy []byte

	err := rows.Scan(
		&w.ID, &w.RepoID, &w.OrgID, &w.UserID,
		&parentID, &templateID, &w.Type,
		&w.Intent, &w.Status, &w.ApprovalStatus, &policy, &errStr,
		&w.CreatedAt, &w.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if parentID.Valid {
		w.ParentID = &parentID.String
	}
	if templateID.Valid {
		w.TemplateID = &templateID.String
	}
	if errStr.Valid {
		w.Error = &errStr.String
	}
	w.ApprovalPolicy = json.RawMessage(policy)
	return &w, nil
}

func scanPlan(row *sql.Row) (*models.Plan, error) {
	var p models.Plan
	var body []byte
	err := row.Scan(
		&p.ID, &p.WorkItemID, &p.Version, &p.SchemaVersion,
		&p.PlanType, &p.PlannerID, &body, &p.IsActive, &p.CreatedBy, &p.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	p.Body = json.RawMessage(body)
	return &p, nil
}

func scanPlanRow(rows *sql.Rows) (*models.Plan, error) {
	var p models.Plan
	var body []byte
	err := rows.Scan(
		&p.ID, &p.WorkItemID, &p.Version, &p.SchemaVersion,
		&p.PlanType, &p.PlannerID, &body, &p.IsActive, &p.CreatedBy, &p.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	p.Body = json.RawMessage(body)
	return &p, nil
}

// joinStrings joins a slice of strings with a separator.
func joinStrings(ss []string, sep string) string {
	result := ""
	for i, s := range ss {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}
