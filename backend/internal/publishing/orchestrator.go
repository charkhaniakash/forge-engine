package publishing

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// Orchestrator drives the complete Git publishing pipeline.
type Orchestrator struct {
	repo             *Repository
	workItemRepo     *repository.WorkItemRepository
	execRepo         *repository.ExecutionRepository
	workspaceManager *workspace.WorkspaceManager
	githubClient     *GitHubPRClient
	agentClient      *AgentSummaryClient
	publisher        func(sessionID, eventType string, payload map[string]interface{})
	onStartHook      func(sessionID, workspaceID string)
	jwtSecret        string
	logger           *zap.SugaredLogger
}

// NewOrchestrator creates a publishing orchestrator.
func NewOrchestrator(
	repo *Repository,
	workItemRepo *repository.WorkItemRepository,
	execRepo *repository.ExecutionRepository,
	workspaceManager *workspace.WorkspaceManager,
	githubClient *GitHubPRClient,
	agentClient *AgentSummaryClient,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *Orchestrator {
	return &Orchestrator{
		repo:             repo,
		workItemRepo:     workItemRepo,
		execRepo:         execRepo,
		workspaceManager: workspaceManager,
		githubClient:     githubClient,
		agentClient:      agentClient,
		jwtSecret:        jwtSecret,
		logger:           logger,
	}
}

// SetPublisher wires the WebSocket publisher after construction.
func (o *Orchestrator) SetPublisher(pub func(sessionID, eventType string, payload map[string]interface{})) {
	o.publisher = pub
}

// GetPublisher returns the current publisher (used by the EventBridge to wrap it).
func (o *Orchestrator) GetPublisher() func(sessionID, eventType string, payload map[string]interface{}) {
	return o.publisher
}

// SetOnStartHook registers a callback invoked when a publishing session is
// created, binding sessionID→workspaceID so the EventBridge can resolve the
// target gateway.
func (o *Orchestrator) SetOnStartHook(hook func(sessionID, workspaceID string)) {
	o.onStartHook = hook
}

// publish emits a progress event to WebSocket subscribers.
func (o *Orchestrator) publish(sessionID, step, status, message string) {
	if o.publisher != nil {
		o.publisher(sessionID, "publishing_progress", map[string]interface{}{
			"step":    step,
			"status":  status,
			"message": message,
			"ts":      time.Now().UnixMilli(),
		})
	}
}

// Run executes the full publishing pipeline for a work item.
func (o *Orchestrator) Run(ctx context.Context, req PublishRequest) error {
	log := o.logger.With(
		"work_item_id", req.WorkItemID,
		"task_execution_id", req.TaskExecutionID,
		"workspace_id", req.WorkspaceID,
		"trace_id", req.TraceID,
	)
	log.Info("publishing_starting")

	// Create publishing session
	session, err := o.repo.CreateSession(ctx, req)
	if err != nil {
		return fmt.Errorf("create publishing session: %w", err)
	}
	log = log.With("session_id", session.ID)

	// Emit session started event
	o.publish(session.ID, "publishing_started", "started", "Publishing workflow started")

	// Run each step sequentially with error handling
	steps := []struct {
		name   string
		status string
		fn     func(context.Context, *PublishingSession, PublishRequest, *zap.SugaredLogger) error
	}{
		{StepVerify, StatusVerifying, o.stepVerifyWorkspace},
		{StepBranch, StatusBranching, o.stepCreateBranch},
		{StepCommit, StatusCommitting, o.stepCreateCommits},
		{StepConflictCheck, StatusConflictCheck, o.stepCheckConflicts},
		{StepPush, StatusPushing, o.stepPushBranch},
		{StepCreatePR, StatusCreatingPR, o.stepCreatePR},
		{StepSync, StatusSyncing, o.stepSyncGitHub},
	}

	for _, step := range steps {
		log.Infow("publishing_step_starting", "step", step.name)
		o.publish(session.ID, step.name, "started", fmt.Sprintf("Starting %s", step.name))

		if err := o.repo.UpdateSessionStep(ctx, session.ID, step.status, step.name); err != nil {
			log.Warnw("update_session_step_failed", "error", err)
		}

		if err := step.fn(ctx, session, req, log); err != nil {
			log.Errorw("publishing_step_failed", "step", step.name, "error", err)
			o.publish(session.ID, step.name, "failed", err.Error())
			_ = o.repo.MarkSessionFailed(ctx, session.ID, step.name, err.Error())
			_ = o.repo.AuditLog(ctx, session.ID, req.WorkItemID, "failed", "system", nil, map[string]interface{}{
				"step": step.name, "error": err.Error(),
			})
			return err
		}

		o.publish(session.ID, step.name, "completed", fmt.Sprintf("%s completed", step.name))
		log.Infow("publishing_step_completed", "step", step.name)
	}

	// Mark session completed
	branchName := ""
	if session.BranchName != nil {
		branchName = *session.BranchName
	}
	prNum := 0
	if session.PRNumber != nil {
		prNum = *session.PRNumber
	}
	prURL := ""
	if session.PRURL != nil {
		prURL = *session.PRURL
	}
	_ = o.repo.MarkSessionCompleted(ctx, session.ID, branchName, prNum, prURL)

	// Transition work item to done/published
	_ = o.workItemRepo.TransitionToDone(ctx, req.WorkItemID)

	// Final event
	o.publish(session.ID, StepComplete, "completed", "Pull Request created successfully")
	if o.publisher != nil {
		o.publisher(session.ID, "publishing_complete", map[string]interface{}{
			"pr_url":    prURL,
			"pr_number": prNum,
			"branch":    branchName,
			"ts":        time.Now().UnixMilli(),
		})
	}

	_ = o.repo.AuditLog(ctx, session.ID, req.WorkItemID, "completed", "system", nil, map[string]interface{}{
		"pr_url": prURL, "pr_number": prNum, "branch": branchName,
	})

	log.Infow("publishing_complete", "pr_url", prURL, "pr_number", prNum)
	return nil
}

// ── Step 1: Verify Workspace ────────────────────────────────────────────────

func (o *Orchestrator) stepVerifyWorkspace(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	// Verify workspace is running
	events, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command: []string{"git", "status", "--porcelain"},
		WorkingDir: "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return fmt.Errorf("workspace not accessible: %w", err)
	}

	// Drain events to check output
	var output string
	for ev := range events {
		if ev.Type == "stdout" {
			output += string(ev.Data)
		}
		if ev.Type == "error" {
			return fmt.Errorf("workspace git status failed: %s", string(ev.Data))
		}
	}

	log.Infow("workspace_verified", "git_status_lines", len(strings.Split(output, "\n")))
	return nil
}

// ── Step 2: Create Branch ───────────────────────────────────────────────────

func (o *Orchestrator) stepCreateBranch(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	// Generate branch name from work item intent
	item, err := o.workItemRepo.GetByIDInternal(ctx, req.WorkItemID)
	if err != nil {
		return fmt.Errorf("load work item: %w", err)
	}

	// Key the branch on the task execution, not the work item, so that a
	// re-plan (which starts a new execution) always produces a distinct branch
	// and therefore a fresh PR — never colliding with a branch/PR left on
	// GitHub by a previous run of the same work item.
	branchName := generateBranchName(item.Intent, req.TaskExecutionID)
	log.Infow("branch_name_generated", "branch", branchName)

	// Check if branch already exists for this work item (idempotent)
	existingBranch, _ := o.repo.GetBranchForWorkItem(ctx, req.WorkItemID)
	if existingBranch != nil && existingBranch.Status == "pushed" {
		// Reuse existing branch — but must checkout in workspace
		branchName = existingBranch.BranchName
		events, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
			Command:        []string{"git", "checkout", branchName},
			WorkingDir:     "",
			TimeoutSeconds: 10,
		})
		if err != nil {
			// Branch exists in DB but not locally — create it fresh
			log.Warnw("existing_branch_checkout_failed_recreating", "error", err)
		} else {
			for range events {
			}
			session.BranchName = &branchName
			log.Infow("reusing_existing_branch", "branch", branchName)
			return nil
		}
	}

	// Create (or force-reset) branch in workspace. Use -B to handle the case
	// where the branch exists locally from a previous failed attempt.
	events, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "checkout", "-B", branchName},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return fmt.Errorf("create branch: %w", err)
	}
	for ev := range events {
		if ev.Type == "error" && !strings.Contains(string(ev.Data), "Switched to") {
			return fmt.Errorf("branch creation failed: %s", string(ev.Data))
		}
	}

	// Persist branch record
	_, err = o.repo.CreateBranch(ctx, req.WorkItemID, session.ID, branchName, req.BaseCommitSHA)
	if err != nil {
		return fmt.Errorf("persist branch: %w", err)
	}

	// Persist to session immediately for crash recovery
	_ = o.repo.UpdateSessionBranch(ctx, session.ID, branchName)

	session.BranchName = &branchName
	log.Infow("branch_created", "branch", branchName)
	return nil
}

// ── Step 3: Create Commits ──────────────────────────────────────────────────

// hasStagedChanges reports whether the workspace currently has anything staged
// for commit (git diff --cached is non-empty).
func (o *Orchestrator) hasStagedChanges(ctx context.Context, workspaceID string) bool {
	events, err := o.workspaceManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        []string{"git", "diff", "--cached", "--stat"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return false
	}
	var out string
	for ev := range events {
		if ev.Type == "stdout" {
			out += string(ev.Data)
		}
	}
	return strings.TrimSpace(out) != ""
}

func (o *Orchestrator) stepCreateCommits(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	// ── DIAGNOSTIC: log workspace state before any operations ────────────────
	workspaceStatusEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "status", "--porcelain"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	var wsStatusOutput string
	for ev := range workspaceStatusEvents {
		if ev.Type == "stdout" {
			wsStatusOutput += string(ev.Data)
		}
	}
	wsStatusLines := strings.Split(strings.TrimSpace(wsStatusOutput), "\n")
	// Filter out empty strings (blank lines with no unstaged changes)
	var nonEmptyStatus []string
	for _, l := range wsStatusLines {
		if strings.TrimSpace(l) != "" {
			nonEmptyStatus = append(nonEmptyStatus, l)
		}
	}
	log.Infow("diag_pre_stash_workspace_status", "status_line_count", len(nonEmptyStatus), "status_lines", nonEmptyStatus)

	// Log HEAD commit so we know the starting point.
	headEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "rev-parse", "HEAD"},
		WorkingDir:     "",
		TimeoutSeconds: 5,
	})
	var headSHA string
	for ev := range headEvents {
		if ev.Type == "stdout" {
			headSHA = strings.TrimSpace(string(ev.Data))
		}
	}
	log.Infow("diag_pre_stash_head", "sha", headSHA)

	// Log unstaged diff (working tree vs HEAD) so we can compare with staged later.
	unstagedEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "diff", "--stat"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	var unstagedStat string
	for ev := range unstagedEvents {
		if ev.Type == "stdout" {
			unstagedStat += string(ev.Data)
		}
	}
	log.Infow("diag_unstaged_diff_stat", "stat", strings.TrimSpace(unstagedStat))

	// Load execution data for commit message generation
	item, _ := o.workItemRepo.GetByIDInternal(ctx, req.WorkItemID)
	diffs, _ := o.execRepo.ListDiffs(ctx, req.TaskExecutionID)

	// ── DIAGNOSTIC: log the diffs returned by ListDiffs ───────────────────────
	var diffFilePaths []string
	for _, d := range diffs {
		diffFilePaths = append(diffFilePaths, fmt.Sprintf("%s (%s +%d/-%d)", d.FilePath, d.Operation, d.LinesAdded, d.LinesRemoved))
	}
	log.Infow("diag_list_diffs_result", "diff_count", len(diffs), "diffs", diffFilePaths)

	// Build diff summaries for the agent. Initialise as an empty (non-nil) slice
	// so it marshals to [] rather than null — the agent's /summarize endpoint
	// rejects a null "diffs" field (422 list_type).
	diffSummaries := []DiffSummary{}
	for _, d := range diffs {
		op := "modify"
		if d.LinesAdded > 0 && d.LinesRemoved == 0 {
			op = "create"
		}
		diffSummaries = append(diffSummaries, DiffSummary{
			FilePath:  d.FilePath,
			Operation: op,
			Added:     d.LinesAdded,
			Removed:   d.LinesRemoved,
		})
	}

	// Request commit message from agent
	summaryReq := SummaryRequest{
		WorkItemID:      req.WorkItemID,
		TaskExecutionID: req.TaskExecutionID,
		Intent:          item.Intent,
		Steps:           []PlanStepSummary{},
		Diffs:           diffSummaries,
		RequestType:     "commit_message",
		RequestID:       fmt.Sprintf("commit-%s", session.ID[:8]),
	}

	summary, err := o.agentClient.GenerateSummary(ctx, summaryReq)
	if err != nil {
		log.Warnw("agent_commit_message_failed_using_default", "error", err)
		// Fallback: generate a simple commit message
		summary = &SummaryResponse{
			CommitSubject: truncate(item.Intent, 72),
			CommitBody:    fmt.Sprintf("Forge Engine automated implementation\n\nWork Item: %s\nExecution: %s", req.WorkItemID, req.TaskExecutionID),
		}
	}

	// ── DIAGNOSTIC: log what filesToStage will contain ──────────────────────
	var filesToStage []string
	for _, d := range diffs {
		path := d.FilePath
		if strings.HasPrefix(path, "/") {
			path = strings.TrimPrefix(path, "/workspace/")
			if strings.HasPrefix(path, "/") {
				path = path[1:]
			}
		}
		filesToStage = append(filesToStage, path)
	}
	log.Infow("diag_files_to_stage", "count", len(filesToStage), "files", filesToStage)

	if len(filesToStage) > 0 {
		stageCmd := append([]string{"git", "add", "--"}, filesToStage...)
		log.Infow("diag_git_add_command", "cmd", stageCmd)
		events, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
			Command:        stageCmd,
			WorkingDir:     "",
			TimeoutSeconds: 30,
		})
		if err != nil {
			return fmt.Errorf("git add: %w", err)
		}
		for range events {
		}
	} else {
		// Execution recorded no diffs. That does NOT always mean the workspace is
		// unchanged — execution changes aren't always mirrored into code_diffs.
		// Fall back to the actual working tree below rather than hard-failing.
		log.Warnw("no_recorded_diffs_falling_back_to_working_tree")
	}

	// ── DIAGNOSTIC: log staged changes after git add ─────────────────────────
	cachedStatEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "diff", "--cached", "--stat"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	var cachedStat string
	for ev := range cachedStatEvents {
		if ev.Type == "stdout" {
			cachedStat += string(ev.Data)
		}
	}
	log.Infow("diag_post_add_cached_diff_stat", "stat", strings.TrimSpace(cachedStat))

	// If nothing is staged yet (empty code_diffs, or recorded paths that don't
	// match the workspace), fall back to staging the whole working tree. Respects
	// .gitignore, so build artifacts are excluded.
	if !o.hasStagedChanges(ctx, req.WorkspaceID) {
		log.Warnw("nothing_staged_using_add_all")
		fallbackEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
			Command:        []string{"git", "add", "-A"},
			WorkingDir:     "",
			TimeoutSeconds: 30,
		})
		for range fallbackEvents {
		}
		// Log staged state after fallback too
		fallbackStatEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
			Command:        []string{"git", "diff", "--cached", "--stat"},
			WorkingDir:     "",
			TimeoutSeconds: 10,
		})
		var fallbackStat string
		for ev := range fallbackStatEvents {
			if ev.Type == "stdout" {
				fallbackStat += string(ev.Data)
			}
		}
		log.Infow("diag_post_fallback_cached_stat", "stat", strings.TrimSpace(fallbackStat))

		// If the working tree is genuinely clean, there is nothing to publish.
		// Surface a clear, actionable message instead of a cryptic git error.
		if !o.hasStagedChanges(ctx, req.WorkspaceID) {
			return fmt.Errorf("no code changes to publish: this task did not modify any files in the workspace")
		}
	}

	// err is already declared above (from the GenerateSummary call); only events
	// needs declaring here since its earlier binding was scoped to the staging if.
	var events <-chan workspace.ExecutionEvent

	// Build commit message
	commitMsg := summary.CommitSubject
	if summary.CommitBody != "" {
		commitMsg += "\n\n" + summary.CommitBody
	}
	// Add trailers
	commitMsg += fmt.Sprintf("\n\nForge-Work-Item: %s", req.WorkItemID)
	commitMsg += fmt.Sprintf("\nForge-Execution: %s", req.TaskExecutionID)

	// Configure committer identity for this repo only (never global — the
	// sandbox has no default identity, and --author only sets the author,
	// not the committer, so `git commit` fatally refuses without this).
	identityEvents, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "config", "user.name", "Forge Engine"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return fmt.Errorf("git config user.name: %w", err)
	}
	for range identityEvents {
	}
	identityEvents, err = o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "config", "user.email", "forge@forge-engine.dev"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return fmt.Errorf("git config user.email: %w", err)
	}
	for range identityEvents {
	}

	// Create commit
	events, err = o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command: []string{
			"git", "commit", "-m", commitMsg,
			"--author", "Forge Engine <forge@forge-engine.dev>",
		},
		WorkingDir:     "",
		TimeoutSeconds: 30,
	})
	if err != nil {
		return fmt.Errorf("git commit: %w", err)
	}
	var commitOutput string
	var commitExitCode int
	for ev := range events {
		if ev.Type == "stdout" || ev.Type == "stderr" {
			commitOutput += string(ev.Data)
		}
		if ev.Type == "exit" && ev.ExitCode != nil {
			commitExitCode = *ev.ExitCode
		}
	}
	if strings.Contains(commitOutput, "nothing to commit") || strings.Contains(commitOutput, "nothing added to commit") {
		return fmt.Errorf("nothing to commit: workspace has no staged changes. Output: %s", strings.TrimSpace(commitOutput))
	}
	if commitExitCode != 0 {
		return fmt.Errorf("git commit failed (exit %d): %s", commitExitCode, strings.TrimSpace(commitOutput))
	}
	log.Infow("diag_commit_output", "output", strings.TrimSpace(commitOutput))

	// ── DIAGNOSTIC: log the committed diff ────────────────────────────────────
	commitStatEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "show", "--stat", "--oneline", "HEAD"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	var commitStat string
	for ev := range commitStatEvents {
		if ev.Type == "stdout" {
			commitStat += string(ev.Data)
		}
	}
	log.Infow("diag_commit_show_stat", "stat", strings.TrimSpace(commitStat))

	// Get the commit SHA
	var commitSHA string
	events, err = o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command: []string{"git", "rev-parse", "HEAD"},
		WorkingDir: "",
		TimeoutSeconds: 5,
	})
	if err != nil {
		return fmt.Errorf("get commit sha: %w", err)
	}
	for ev := range events {
		if ev.Type == "stdout" {
			commitSHA = strings.TrimSpace(string(ev.Data))
		}
	}

	// Persist commit record
	branch, _ := o.repo.GetBranchForWorkItem(ctx, req.WorkItemID)
	if branch != nil && commitSHA != "" {
		execID := req.TaskExecutionID
		_, _ = o.repo.CreateCommit(ctx, branch.ID, session.ID, commitSHA, commitMsg,
			"Forge Engine", "forge@forge-engine.dev", &execID, 1)
	}

	logSHA := commitSHA
	if len(logSHA) > 8 {
		logSHA = logSHA[:8]
	}
	log.Infow("commit_created", "sha", logSHA)
	return nil
}

// ── Step 3.5: Check for Base Branch Conflicts ───────────────────────────────

func (o *Orchestrator) stepCheckConflicts(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	// Fetch latest state of the default branch from remote
	token, err := o.githubClient.GetPushToken(ctx, req.RepoFullName)
	if err != nil {
		log.Warnw("conflict_check_token_failed", "error", err)
		return nil
	}

	// Inline credential helper (no file needed — avoids noexec tmpfs issue)
	credHelperArg := fmt.Sprintf(
		`!f(){ echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=%s"; echo ""; }; f`,
		token,
	)

	remoteURL := fmt.Sprintf("https://github.com/%s.git", req.RepoFullName)
	events, err := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command: []string{
			"git",
			"-c", "credential.helper=" + credHelperArg,
			"fetch", remoteURL, req.DefaultBranch,
		},
		WorkingDir:     "",
		TimeoutSeconds: 60,
		Env: map[string]string{
			"GIT_TERMINAL_PROMPT": "0",
		},
	})
	if err != nil {
		log.Warnw("conflict_check_fetch_failed", "error", err)
		return nil // non-fatal
	}
	for range events {
	}

	// Check if base commit is still an ancestor of the remote default branch
	events, err = o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "merge-base", "--is-ancestor", req.BaseCommitSHA, "FETCH_HEAD"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		log.Warnw("conflict_check_merge_base_failed", "error", err)
		return nil // non-fatal
	}

	for ev := range events {
		if ev.Type == "exit" && ev.ExitCode != nil && *ev.ExitCode != 0 {
			// Base commit is NOT an ancestor — base branch has diverged
			log.Warnw("base_branch_diverged", "base_sha", req.BaseCommitSHA)
			// Check for actual conflicts by trying a merge
			mergeEvents, mergeErr := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
				Command:        []string{"git", "merge", "--no-commit", "--no-ff", "FETCH_HEAD"},
				WorkingDir:     "",
				TimeoutSeconds: 30,
			})
			if mergeErr == nil {
				var mergeOutput string
				for mev := range mergeEvents {
					if mev.Type == "stdout" || mev.Type == "stderr" {
						mergeOutput += string(mev.Data)
					}
					if mev.Type == "exit" && mev.ExitCode != nil && *mev.ExitCode != 0 {
						// Conflicts detected — abort merge and fail
						abortEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
							Command:        []string{"git", "merge", "--abort"},
							WorkingDir:     "",
							TimeoutSeconds: 10,
						})
						for range abortEvents {
						}
						return fmt.Errorf("merge conflicts detected with base branch (%s has diverged): %s", req.DefaultBranch, strings.TrimSpace(mergeOutput))
					}
				}
				// No conflicts — abort the merge (we just wanted to check)
				abortEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
					Command:        []string{"git", "merge", "--abort"},
					WorkingDir:     "",
					TimeoutSeconds: 10,
				})
				for range abortEvents {
				}
			}
			log.Infow("base_branch_diverged_no_conflicts", "note", "PR will show divergence but no conflicts")
		}
	}

	log.Infow("conflict_check_passed")
	return nil
}

// ── Step 4: Push Branch ─────────────────────────────────────────────────────

func (o *Orchestrator) stepPushBranch(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	branchName := ""
	if session.BranchName != nil {
		branchName = *session.BranchName
	}
	if branchName == "" {
		return fmt.Errorf("no branch name set")
	}

	// Get a fresh installation token for pushing
	token, err := o.githubClient.GetPushToken(ctx, req.RepoFullName)
	if err != nil {
		return fmt.Errorf("get push token: %w", err)
	}

	// Security: inject token via inline credential helper function.
	// This avoids writing any script file (tmpfs has noexec in this container).
	// The token appears only in the git config -c argument, not in the URL.
	// Git spawns sh -c to evaluate the credential helper string.
	credHelperArg := fmt.Sprintf(
		`!f(){ echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=%s"; echo ""; }; f`,
		token,
	)

	// Push with retry (up to PushMaxRetries attempts). Token injected via credential helper.
	remoteURL := fmt.Sprintf("https://github.com/%s.git", req.RepoFullName)
	var pushErr error
	for attempt := 1; attempt <= PushMaxRetries; attempt++ {
		events, execErr := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
			Command: []string{
				"git",
				"-c", "credential.helper=" + credHelperArg,
				"push", remoteURL, branchName,
			},
			WorkingDir:     "",
			TimeoutSeconds: 120,
			Env: map[string]string{
				"GIT_TERMINAL_PROMPT": "0",
			},
		})
		if execErr != nil {
			pushErr = execErr
			time.Sleep(time.Duration(attempt) * 2 * time.Second)
			continue
		}

		pushErr = nil
		var stderr string
		for ev := range events {
			if ev.Type == "stderr" {
				stderr += string(ev.Data)
			}
			if ev.Type == "exit" && ev.ExitCode != nil && *ev.ExitCode != 0 {
				pushErr = fmt.Errorf("push failed (exit %d): %s", *ev.ExitCode, redactToken(stderr, token))
			}
		}
		if pushErr == nil {
			break
		}

		log.Warnw("push_retry", "attempt", attempt, "error", redactToken(pushErr.Error(), token))
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}

	if pushErr != nil {
		return fmt.Errorf("push failed after %d attempts: %w", PushMaxRetries, pushErr)
	}

	// Update branch head SHA
	headSHA := ""
	headEvents, _ := o.workspaceManager.Exec(ctx, req.WorkspaceID, workspace.ExecRequest{
		Command:        []string{"git", "rev-parse", "HEAD"},
		WorkingDir:     "",
		TimeoutSeconds: 5,
	})
	for ev := range headEvents {
		if ev.Type == "stdout" {
			headSHA = strings.TrimSpace(string(ev.Data))
		}
	}

	branch, _ := o.repo.GetBranchForWorkItem(ctx, req.WorkItemID)
	if branch != nil && len(headSHA) >= 8 {
		_ = o.repo.UpdateBranchHead(ctx, branch.ID, headSHA, "pushed")
	}

	// Persist branch name to session immediately (crash recovery)
	_ = o.repo.UpdateSessionBranch(ctx, session.ID, branchName)

	logSHA := headSHA
	if len(logSHA) > 8 {
		logSHA = logSHA[:8]
	}
	log.Infow("branch_pushed", "branch", branchName, "head", logSHA)
	return nil
}

// ── Step 5: Create Pull Request ─────────────────────────────────────────────

func (o *Orchestrator) stepCreatePR(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	branchName := ""
	if session.BranchName != nil {
		branchName = *session.BranchName
	}

	// Check for existing PR (idempotent)
	existingPR, _ := o.repo.GetPRForWorkItem(ctx, req.WorkItemID)
	if existingPR != nil && (existingPR.State == "open" || existingPR.State == "draft") {
		// Update existing PR
		session.PRNumber = &existingPR.PRNumber
		session.PRURL = &existingPR.URL
		log.Infow("reusing_existing_pr", "pr_number", existingPR.PRNumber)
		return nil
	}

	// Load execution data for PR description
	item, _ := o.workItemRepo.GetByIDInternal(ctx, req.WorkItemID)
	diffs, _ := o.execRepo.ListDiffs(ctx, req.TaskExecutionID)

	var diffSummaries []DiffSummary
	for _, d := range diffs {
		op := "modify"
		if d.LinesAdded > 0 && d.LinesRemoved == 0 {
			op = "create"
		}
		diffSummaries = append(diffSummaries, DiffSummary{
			FilePath:  d.FilePath,
			Operation: op,
			Added:     d.LinesAdded,
			Removed:   d.LinesRemoved,
		})
	}

	// Request PR description from agent
	summaryReq := SummaryRequest{
		WorkItemID:      req.WorkItemID,
		TaskExecutionID: req.TaskExecutionID,
		Intent:          item.Intent,
		Steps:           []PlanStepSummary{},
		Diffs:           diffSummaries,
		RequestType:     "pr_description",
		RequestID:       fmt.Sprintf("pr-%s", session.ID[:8]),
	}

	summary, err := o.agentClient.GenerateSummary(ctx, summaryReq)
	if err != nil {
		log.Warnw("agent_pr_description_failed_using_default", "error", err)
		summary = &SummaryResponse{
			PRTitle: truncate(item.Intent, 72),
			PRBody:  fmt.Sprintf("## Automated Implementation\n\n**Intent:** %s\n\n**Files changed:** %d\n\n---\n*Created by Forge Engine*", item.Intent, len(diffs)),
		}
	}

	// Create PR via GitHub API
	prResult, err := o.githubClient.CreatePR(ctx, CreatePRRequest{
		RepoFullName:  req.RepoFullName,
		Head:          branchName,
		Base:          req.DefaultBranch,
		Title:         summary.PRTitle,
		Body:          summary.PRBody,
		Draft:         req.DraftMode,
	})
	if err != nil {
		return fmt.Errorf("create PR: %w", err)
	}

	// Persist PR record
	branch, _ := o.repo.GetBranchForWorkItem(ctx, req.WorkItemID)
	if branch == nil {
		return fmt.Errorf("branch record not found — cannot persist PR without branch FK")
	}

	pr := &PullRequest{
		WorkItemID: req.WorkItemID,
		BranchID:   branch.ID,
		SessionID:  session.ID,
		PRNumber:   prResult.Number,
		GitHubPRID: &prResult.ID,
		URL:        prResult.HTMLURL,
		Title:      summary.PRTitle,
		State:      prResult.State,
		Draft:      req.DraftMode,
		BaseBranch: req.DefaultBranch,
		HeadSHA:    &prResult.HeadSHA,
	}
	_ = o.repo.CreatePullRequest(ctx, pr)

	// Persist to session immediately for crash recovery
	_ = o.repo.UpdateSessionPR(ctx, session.ID, prResult.Number, prResult.HTMLURL)

	session.PRNumber = &prResult.Number
	session.PRURL = &prResult.HTMLURL
	log.Infow("pr_created", "number", prResult.Number, "url", prResult.HTMLURL)
	return nil
}

// ── Step 6: Sync GitHub State ───────────────────────────────────────────────

func (o *Orchestrator) stepSyncGitHub(ctx context.Context, session *PublishingSession, req PublishRequest, log *zap.SugaredLogger) error {
	if session.PRNumber == nil {
		return nil // nothing to sync
	}

	prState, err := o.githubClient.GetPRState(ctx, req.RepoFullName, *session.PRNumber)
	if err != nil {
		log.Warnw("github_sync_failed", "error", err)
		// Non-fatal: sync failures don't block publishing
		return nil
	}

	// Update PR record with latest state
	existingPR, _ := o.repo.GetPRForWorkItem(ctx, req.WorkItemID)
	if existingPR != nil {
		_ = o.repo.UpdatePRState(ctx, existingPR.ID, prState.State, prState.Mergeable, prState.ReviewState)
	}

	log.Infow("github_synced", "state", prState.State, "mergeable", prState.Mergeable)
	return nil
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// generateBranchName creates a collision-resistant branch name from the intent.
// generateBranchName builds a branch name from the intent slug plus a short
// unique id. The uniqueID should be the task execution id so each run (including
// re-plans) gets its own branch, while retries within a single run stay stable.
func generateBranchName(intent, uniqueID string) string {
	// Slugify the intent
	slug := slugify(intent)
	if len(slug) > 40 {
		slug = slug[:40]
	}
	// Short ID for uniqueness (task execution id → unique per run)
	shortID := uniqueID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return fmt.Sprintf("forge/%s-%s", slug, shortID)
}

// slugify converts text to a URL-safe slug.
func slugify(s string) string {
	s = strings.ToLower(s)
	var buf strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			buf.WriteRune(r)
		} else if r == ' ' || r == '-' || r == '_' {
			buf.WriteRune('-')
		}
	}
	// Collapse multiple hyphens
	result := regexp.MustCompile(`-+`).ReplaceAllString(buf.String(), "-")
	return strings.Trim(result, "-")
}

// truncate truncates a string to maxLen.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}

// redactToken removes token values from error messages.
func redactToken(msg, token string) string {
	if token == "" {
		return msg
	}
	return strings.ReplaceAll(msg, token, "***REDACTED***")
}

// Placeholder types referenced by orchestrator

// CodeDiff represents a diff record from the execution repo.
type CodeDiff = models.CodeDiff
