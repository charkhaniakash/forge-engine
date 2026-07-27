package handlers

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// WorkspaceHandlers exposes the Phase 6 sandbox management endpoints.
//
// Approval gate: POST .../workspace requires work_item.approval_status = 'approved'.
// This is the hard server-side enforcement — the frontend can show/hide
// the button, but the backend always checks independently.
type WorkspaceHandlers struct {
	manager      *workspace.WorkspaceManager
	wsRepo       *repository.WorkspaceRepository
	workItemRepo *repository.WorkItemRepository
	repoRepo     *repository.GitHubRepoRepository
	installRepo  *repository.GitHubInstallationRepository
	jobRepo      *repository.IngestionJobRepository
	logger       *zap.SugaredLogger
}

// NewWorkspaceHandlers constructs WorkspaceHandlers.
func NewWorkspaceHandlers(
	manager *workspace.WorkspaceManager,
	wsRepo *repository.WorkspaceRepository,
	workItemRepo *repository.WorkItemRepository,
	repoRepo *repository.GitHubRepoRepository,
	installRepo *repository.GitHubInstallationRepository,
	jobRepo *repository.IngestionJobRepository,
	logger *zap.SugaredLogger,
) *WorkspaceHandlers {
	return &WorkspaceHandlers{
		manager:      manager,
		wsRepo:       wsRepo,
		workItemRepo: workItemRepo,
		repoRepo:     repoRepo,
		installRepo:  installRepo,
		jobRepo:      jobRepo,
		logger:       logger,
	}
}

// ── POST /v1/repos/:repoID/tasks/:taskID/workspace ────────────────────────────
// Provisions a new workspace for an approved task. Blocks until the workspace
// is ready (repo cloned and checked out) or an error occurs.

func (h *WorkspaceHandlers) ProvisionWorkspace(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	// Load and authorise the work item.
	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Hard approval gate — no exceptions.
	if item.ApprovalStatus != "approved" && item.ApprovalStatus != "auto_approved" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": fmt.Sprintf(
				"task must be approved before a workspace can be provisioned (current: %s)",
				item.ApprovalStatus,
			),
		})
	}

	// Load repo and installation metadata.
	repo, err := h.repoRepo.GetByID(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "repo not found"})
	}

	installation, err := h.installRepo.GetByID(ctx, repo.InstallationID)
	if err != nil {
		h.logger.Errorw("workspace_provision_install_not_found",
			"task_id", taskID, "repo_id", repoID,
			"install_id", repo.InstallationID, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "GitHub installation not found",
		})
	}

	// Resolve the commit SHA: from the active plan if available, else from the latest done ingestion job.
	commitSHA, err := h.resolveCommitSHA(ctx, taskID, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("could not resolve commit SHA: %v", err),
		})
	}

	h.logger.Infow("workspace_provision_started",
		"task_id", taskID, "repo_id", repoID,
		"commit_sha", commitSHA[:8], "trace_id", traceID)

	ws, err := h.manager.Provision(
		ctx,
		item.ID,
		repo.ID,
		repo.RepoFullName,
		commitSHA,
		installation.GitHubInstallationID,
	)
	if err != nil {
		h.logger.Errorw("workspace_provision_failed",
			"task_id", taskID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("failed to provision workspace: %v", err),
		})
	}

	h.logger.Infow("workspace_provision_complete",
		"workspace_id", ws.ID, "task_id", taskID, "trace_id", traceID)

	return c.Status(fiber.StatusCreated).JSON(ws)
}

// ── GET /v1/repos/:repoID/tasks/:taskID/workspace ─────────────────────────────
// Returns the current workspace status for a task.

func (h *WorkspaceHandlers) GetWorkspace(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	// Verify task ownership.
	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	ws, err := h.wsRepo.GetByWorkItemID(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no workspace found for this task"})
	}

	return c.JSON(ws)
}

// ── DELETE /v1/repos/:repoID/tasks/:taskID/workspace ─────────────────────────
// Manually destroys a workspace.

func (h *WorkspaceHandlers) DestroyWorkspace(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	ws, err := h.wsRepo.GetByWorkItemID(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no workspace found for this task"})
	}

	if err := h.manager.Destroy(ctx, ws.ID); err != nil {
		h.logger.Errorw("workspace_destroy_failed",
			"workspace_id", ws.ID, "trace_id", traceID, "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("failed to destroy workspace: %v", err),
		})
	}

	return c.JSON(fiber.Map{"status": "destroyed", "workspace_id": ws.ID})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/workspace/logs ────────────────────────
// Returns all execution log entries for the task's workspace.

func (h *WorkspaceHandlers) GetWorkspaceLogs(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	ws, err := h.wsRepo.GetByWorkItemID(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no workspace found for this task"})
	}

	logs, err := h.wsRepo.ListLogs(ctx, ws.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load logs"})
	}
	if logs == nil {
		logs = []*models.ExecutionLog{}
	}

	return c.JSON(fiber.Map{"workspace_id": ws.ID, "logs": logs})
}

// ── POST /v1/internal/workspaces/:workspaceID/exec ────────────────────────────
// Internal execution endpoint. Protected by internal JWT.
// Phase 6: registered but will be called by Phase 7's agent tool routing.

type ExecRequestBody struct {
	Command        []string          `json:"command"`
	WorkingDir     string            `json:"working_dir,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutSeconds int               `json:"timeout_seconds,omitempty"`
}

func (h *WorkspaceHandlers) InternalExec(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var body ExecRequestBody
	if err := c.BodyParser(&body); err != nil || len(body.Command) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "command array is required",
		})
	}

	// Reject shell strings — only argv arrays are accepted.
	if len(body.Command) == 1 && containsShellMeta(body.Command[0]) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "shell strings are not accepted — provide an argv array",
		})
	}

	req := workspace.ExecRequest{
		Command:        body.Command,
		WorkingDir:     body.WorkingDir,
		Env:            body.Env,
		TimeoutSeconds: body.TimeoutSeconds,
	}

	start := time.Now()

	ch, err := h.manager.Exec(ctx, workspaceID, req)
	if err != nil {
		h.logger.Errorw("internal_exec_failed",
			"workspace_id", workspaceID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	// Non-streaming path: drain the channel and return the result.
	// Phase 7 will add the streaming path on this same endpoint.
	var stdoutBuf, stderrBuf []byte
	exitCode := -1
	timedOut := false

	for event := range ch {
		switch event.Type {
		case "stdout":
			stdoutBuf = append(stdoutBuf, event.Data...)
		case "stderr":
			stderrBuf = append(stderrBuf, event.Data...)
		case "exit":
			if event.ExitCode != nil {
				exitCode = *event.ExitCode
			}
		case "timeout":
			timedOut = true
		}
	}

	durationMS := int(time.Since(start).Milliseconds())

	h.logger.Infow("internal_exec_complete",
		"workspace_id", workspaceID,
		"command", body.Command[0],
		"exit_code", exitCode,
		"duration_ms", durationMS,
		"trace_id", traceID,
	)

	return c.JSON(fiber.Map{
		"exit_code":   exitCode,
		"stdout":      string(stdoutBuf),
		"stderr":      string(stderrBuf),
		"timed_out":   timedOut,
		"duration_ms": durationMS,
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// resolveCommitSHA returns the commit SHA to use for the workspace.
// Priority:
//   1. github_repos.last_commit_sha — updated immediately on push webhooks,
//      so workspace provisioning gets the latest HEAD without waiting for
//      ingestion to finish. This is the primary source.
//   2. Latest done ingestion job's commit_sha — fallback for repos that
//      haven't received a push webhook yet (initial setup).
func (h *WorkspaceHandlers) resolveCommitSHA(
	ctx context.Context,
	taskID string,
	repoID string,
) (string, error) {
	// Priority 1: github_repos.last_commit_sha (updated on push webhooks).
	repo, err := h.repoRepo.GetByID(ctx, repoID)
	if err != nil {
		return "", fmt.Errorf("repo not found: %w", err)
	}
	if repo.LastCommitSHA != nil && *repo.LastCommitSHA != "" {
		return *repo.LastCommitSHA, nil
	}

	// Priority 2: latest done ingestion job's commit SHA (fallback).
	job, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return "", fmt.Errorf("no completed ingestion job found for repo")
	}
	if job.CommitSHA == "" {
		return "", fmt.Errorf("both last_commit_sha and ingestion job have empty commit SHA")
	}
	return job.CommitSHA, nil
}

// containsShellMeta returns true if a string contains shell metacharacters,
// which would indicate someone is passing a shell string instead of an argv array.
func containsShellMeta(s string) bool {
	for _, ch := range []string{";", "&&", "||", "|", ">", "<", "`", "$"} {
		if len(s) > 2 && containsStr(s, ch) {
			return true
		}
	}
	return false
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > len(sub) && (s[:len(sub)] == sub || containsStr(s[1:], sub)))
}
