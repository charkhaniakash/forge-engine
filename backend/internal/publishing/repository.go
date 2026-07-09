package publishing

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Repository handles persistence for publishing sessions and Git artifacts.
type Repository struct {
	db *sql.DB
}

// NewRepository creates a new publishing repository.
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// ── Publishing Sessions ─────────────────────────────────────────────────────

// CreateSession creates a new publishing session.
func (r *Repository) CreateSession(ctx context.Context, req PublishRequest) (*PublishingSession, error) {
	session := &PublishingSession{
		WorkItemID:      req.WorkItemID,
		TaskExecutionID: req.TaskExecutionID,
		WorkspaceID:     req.WorkspaceID,
		Status:          StatusPending,
		DraftMode:       req.DraftMode,
		InitiatedBy:     &req.UserID,
	}

	err := r.db.QueryRowContext(ctx, `
		INSERT INTO publishing_sessions (work_item_id, task_execution_id, workspace_id, status, draft_mode, initiated_by)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, created_at, updated_at
	`, session.WorkItemID, session.TaskExecutionID, session.WorkspaceID,
		session.Status, session.DraftMode, session.InitiatedBy,
	).Scan(&session.ID, &session.CreatedAt, &session.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create publishing session: %w", err)
	}
	return session, nil
}

// GetSession retrieves a publishing session by ID.
func (r *Repository) GetSession(ctx context.Context, id string) (*PublishingSession, error) {
	s := &PublishingSession{}
	err := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, task_execution_id, workspace_id, status, current_step,
		       branch_name, pr_number, pr_url, draft_mode, error_message,
		       cancellation_reason, initiated_by, started_at, completed_at, created_at, updated_at
		FROM publishing_sessions WHERE id = $1
	`, id).Scan(
		&s.ID, &s.WorkItemID, &s.TaskExecutionID, &s.WorkspaceID, &s.Status, &s.CurrentStep,
		&s.BranchName, &s.PRNumber, &s.PRURL, &s.DraftMode, &s.ErrorMessage,
		&s.CancelReason, &s.InitiatedBy, &s.StartedAt, &s.CompletedAt, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get publishing session: %w", err)
	}
	return s, nil
}

// GetLatestForWorkItem retrieves the most recent publishing session for a work item.
func (r *Repository) GetLatestForWorkItem(ctx context.Context, workItemID string) (*PublishingSession, error) {
	s := &PublishingSession{}
	err := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, task_execution_id, workspace_id, status, current_step,
		       branch_name, pr_number, pr_url, draft_mode, error_message,
		       cancellation_reason, initiated_by, started_at, completed_at, created_at, updated_at
		FROM publishing_sessions WHERE work_item_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, workItemID).Scan(
		&s.ID, &s.WorkItemID, &s.TaskExecutionID, &s.WorkspaceID, &s.Status, &s.CurrentStep,
		&s.BranchName, &s.PRNumber, &s.PRURL, &s.DraftMode, &s.ErrorMessage,
		&s.CancelReason, &s.InitiatedBy, &s.StartedAt, &s.CompletedAt, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get latest publishing session: %w", err)
	}
	return s, nil
}

// UpdateSessionStep updates the current step and status.
func (r *Repository) UpdateSessionStep(ctx context.Context, id, status, step string) error {
	now := time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions
		SET status = $2, current_step = $3, started_at = COALESCE(started_at, $4), updated_at = $4
		WHERE id = $1
	`, id, status, step, now)
	if err != nil {
		return fmt.Errorf("update session step: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("update session step: no row found for session %s", id)
	}
	return nil
}

// MarkSessionCompleted marks a session as completed with PR details.
func (r *Repository) MarkSessionCompleted(ctx context.Context, id, branchName string, prNumber int, prURL string) error {
	now := time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions
		SET status = 'completed', current_step = 'publishing_complete',
		    branch_name = $2, pr_number = $3, pr_url = $4, completed_at = $5, updated_at = $5
		WHERE id = $1
	`, id, branchName, prNumber, prURL, now)
	if err != nil {
		return fmt.Errorf("mark session completed: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("mark session completed: no row found for session %s", id)
	}
	return nil
}

// MarkSessionFailed marks a session as failed with an error message.
func (r *Repository) MarkSessionFailed(ctx context.Context, id, step, errMsg string) error {
	now := time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions
		SET status = 'failed', current_step = $2, error_message = $3, completed_at = $4, updated_at = $4
		WHERE id = $1
	`, id, step, errMsg, now)
	if err != nil {
		return fmt.Errorf("mark session failed: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("mark session failed: no row found for session %s", id)
	}
	return nil
}

// MarkSessionCancelled marks a session as cancelled.
func (r *Repository) MarkSessionCancelled(ctx context.Context, id, reason string) error {
	now := time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions
		SET status = 'cancelled', cancellation_reason = $2, completed_at = $3, updated_at = $3
		WHERE id = $1
	`, id, reason, now)
	if err != nil {
		return fmt.Errorf("mark session cancelled: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("mark session cancelled: no row found for session %s", id)
	}
	return nil
}

// UpdateSessionBranch persists the branch name to the session for crash recovery.
func (r *Repository) UpdateSessionBranch(ctx context.Context, id, branchName string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions SET branch_name = $2, updated_at = NOW()
		WHERE id = $1
	`, id, branchName)
	if err != nil {
		return fmt.Errorf("update session branch: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("update session branch: no row found for session %s", id)
	}
	return nil
}

// UpdateSessionPR persists the PR number and URL to the session for crash recovery.
func (r *Repository) UpdateSessionPR(ctx context.Context, id string, prNumber int, prURL string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE publishing_sessions SET pr_number = $2, pr_url = $3, updated_at = NOW()
		WHERE id = $1
	`, id, prNumber, prURL)
	if err != nil {
		return fmt.Errorf("update session PR: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("update session PR: no row found for session %s", id)
	}
	return nil
}

// ── Git Branches ────────────────────────────────────────────────────────────

// CreateBranch persists a git branch record.
func (r *Repository) CreateBranch(ctx context.Context, workItemID, sessionID, branchName, baseCommitSHA string) (*GitBranch, error) {
	b := &GitBranch{
		WorkItemID:    workItemID,
		SessionID:     sessionID,
		BranchName:    branchName,
		BaseCommitSHA: baseCommitSHA,
		Status:        "created",
	}
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO git_branches (work_item_id, session_id, branch_name, base_commit_sha, status)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (branch_name, work_item_id) DO UPDATE SET session_id = $2, updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, b.WorkItemID, b.SessionID, b.BranchName, b.BaseCommitSHA, b.Status,
	).Scan(&b.ID, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create branch: %w", err)
	}
	return b, nil
}

// UpdateBranchHead updates the head commit SHA after push.
func (r *Repository) UpdateBranchHead(ctx context.Context, branchID, headSHA, status string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE git_branches SET head_commit_sha = $2, status = $3, updated_at = NOW()
		WHERE id = $1
	`, branchID, headSHA, status)
	if err != nil {
		return fmt.Errorf("update branch head: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("update branch head: no row found for branch %s", branchID)
	}
	return nil
}

// GetBranchForWorkItem finds an existing branch for this work item.
func (r *Repository) GetBranchForWorkItem(ctx context.Context, workItemID string) (*GitBranch, error) {
	b := &GitBranch{}
	err := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, session_id, branch_name, base_commit_sha, head_commit_sha, status, created_at, updated_at
		FROM git_branches WHERE work_item_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, workItemID).Scan(
		&b.ID, &b.WorkItemID, &b.SessionID, &b.BranchName, &b.BaseCommitSHA,
		&b.HeadCommitSHA, &b.Status, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// ── Git Commits ─────────────────────────────────────────────────────────────

// CreateCommit persists a commit record.
func (r *Repository) CreateCommit(ctx context.Context, branchID, sessionID, commitSHA, message, authorName, authorEmail string, executionID *string, order int) (*GitCommit, error) {
	c := &GitCommit{
		BranchID:    branchID,
		SessionID:   sessionID,
		CommitSHA:   commitSHA,
		Message:     message,
		AuthorName:  authorName,
		AuthorEmail: authorEmail,
		ExecutionID: executionID,
		CommitOrder: order,
	}
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO git_commits (branch_id, session_id, commit_sha, message, author_name, author_email, execution_id, commit_order)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at
	`, c.BranchID, c.SessionID, c.CommitSHA, c.Message, c.AuthorName, c.AuthorEmail, c.ExecutionID, c.CommitOrder,
	).Scan(&c.ID, &c.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("create commit: %w", err)
	}
	return c, nil
}

// ── Pull Requests ───────────────────────────────────────────────────────────

// CreatePullRequest persists a PR record.
func (r *Repository) CreatePullRequest(ctx context.Context, pr *PullRequest) error {
	err := r.db.QueryRowContext(ctx, `
		INSERT INTO pull_requests (work_item_id, branch_id, session_id, pr_number, github_pr_id, url, title, state, draft, base_branch, head_sha)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (pr_number, work_item_id) DO UPDATE
		SET title = $7, state = $8, url = $6, updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, pr.WorkItemID, pr.BranchID, pr.SessionID, pr.PRNumber, pr.GitHubPRID,
		pr.URL, pr.Title, pr.State, pr.Draft, pr.BaseBranch, pr.HeadSHA,
	).Scan(&pr.ID, &pr.CreatedAt, &pr.UpdatedAt)
	return err
}

// GetPRForWorkItem finds an existing PR for this work item.
func (r *Repository) GetPRForWorkItem(ctx context.Context, workItemID string) (*PullRequest, error) {
	pr := &PullRequest{}
	err := r.db.QueryRowContext(ctx, `
		SELECT id, work_item_id, branch_id, session_id, pr_number, github_pr_id, url, title,
		       state, draft, review_state, mergeable, head_sha, base_branch,
		       additions, deletions, changed_files, created_at, updated_at
		FROM pull_requests WHERE work_item_id = $1
		ORDER BY created_at DESC LIMIT 1
	`, workItemID).Scan(
		&pr.ID, &pr.WorkItemID, &pr.BranchID, &pr.SessionID, &pr.PRNumber, &pr.GitHubPRID,
		&pr.URL, &pr.Title, &pr.State, &pr.Draft, &pr.ReviewState, &pr.Mergeable,
		&pr.HeadSHA, &pr.BaseBranch, &pr.Additions, &pr.Deletions, &pr.ChangedFiles,
		&pr.CreatedAt, &pr.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return pr, nil
}

// UpdatePRState updates the PR state and sync data.
func (r *Repository) UpdatePRState(ctx context.Context, id, state string, mergeable *bool, reviewState *string) error {
	res, err := r.db.ExecContext(ctx, `
		UPDATE pull_requests
		SET state = $2, mergeable = $3, review_state = $4, updated_at = NOW()
		WHERE id = $1
	`, id, state, mergeable, reviewState)
	if err != nil {
		return fmt.Errorf("update PR state: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("update PR state: no row found for PR %s", id)
	}
	return nil
}

// ── Audit Log ───────────────────────────────────────────────────────────────

// AuditLog records a publishing action.
func (r *Repository) AuditLog(ctx context.Context, sessionID, workItemID, action, actorType string, actorID *string, details interface{}) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO publishing_audit_log (session_id, work_item_id, action, actor_type, actor_id, details)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, sessionID, workItemID, action, actorType, actorID, details)
	return err
}
