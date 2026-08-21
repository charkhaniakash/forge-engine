package handlers

import (
	"context"
	"encoding/json"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/publishing"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// newExecutionContext builds the execution context shared by the manual
// (StartExecution) and auto-run paths, so they never drift apart.
//
// Model is intentionally left empty: the agent selects its own LLM via its
// provider factory (configured with CHAT__PROVIDER / CHAT__MODEL on the agent —
// Groq, Gemini, OpenAI, Ollama, …) and ignores this field. We deliberately do
// NOT hardcode a provider's model name here.
func newExecutionContext(workspaceID string, planVersion int, traceID, orgID, userID string) models.ExecutionContext {
	return models.ExecutionContext{
		WorkspaceID:   workspaceID,
		PlanVersion:   planVersion,
		TraceID:       traceID,
		OrgID:         orgID,
		UserID:        userID,
		Model:         "", // agent decides — see CHAT__MODEL on the agent service
		Temperature:   0.1,
		MaxTokens:     4096,
		ExecutionMode: "autonomous",
		AutonomyLevel: "full",
	}
}

// AutoRunner performs the server-side "Plan off" sequence — approve → provision
// → execute — once a task's plan is ready. It exists so auto-run is fully
// backend-driven: no client needs to be present, and it's robust to refreshes
// and headless operation. It mirrors the HTTP handlers' logic without fibre.Ctx.
type AutoRunner struct {
	workItemRepo *repository.WorkItemRepository
	wsRepo       *repository.WorkspaceRepository
	wsManager    *workspace.WorkspaceManager
	repoRepo     *repository.GitHubRepoRepository
	installRepo  *repository.GitHubInstallationRepository
	jobRepo      *repository.IngestionJobRepository
	execRepo     *repository.ExecutionRepository
	orchestrator *execution.ExecutionOrchestrator
	publishRepo  *publishing.Repository
	logger       *zap.SugaredLogger
}

func NewAutoRunner(
	workItemRepo *repository.WorkItemRepository,
	wsRepo *repository.WorkspaceRepository,
	wsManager *workspace.WorkspaceManager,
	repoRepo *repository.GitHubRepoRepository,
	installRepo *repository.GitHubInstallationRepository,
	jobRepo *repository.IngestionJobRepository,
	execRepo *repository.ExecutionRepository,
	orchestrator *execution.ExecutionOrchestrator,
	logger *zap.SugaredLogger,
) *AutoRunner {
	return &AutoRunner{
		workItemRepo: workItemRepo,
		wsRepo:       wsRepo,
		wsManager:    wsManager,
		repoRepo:     repoRepo,
		installRepo:  installRepo,
		jobRepo:      jobRepo,
		execRepo:     execRepo,
		orchestrator: orchestrator,
		logger:       logger,
	}
}

func (a *AutoRunner) SetPublishRepo(repo *publishing.Repository) {
	a.publishRepo = repo
}

// Run drives an approved-less task from plan_ready straight through execution.
// Called in a goroutine; owns its own (detached) context.
func (a *AutoRunner) Run(taskID string) {
	ctx := context.Background()
	log := a.logger.With("task_id", taskID, "auto_run", true)

	item, err := a.workItemRepo.GetByIDInternal(ctx, taskID)
	if err != nil {
		log.Errorw("auto_run_load_task_failed", "error", err)
		return
	}

	// 1. Approve (moves plan_ready → plan_approved).
	if _, err := a.workItemRepo.Approve(ctx, taskID, item.OrgID); err != nil {
		log.Errorw("auto_run_approve_failed", "error", err)
		return
	}

	// 2. Resolve repo + installation + commit SHA, then provision the workspace.
	repo, err := a.repoRepo.GetByID(ctx, item.RepoID)
	if err != nil {
		log.Errorw("auto_run_repo_not_found", "error", err)
		return
	}
	installation, err := a.installRepo.GetByID(ctx, repo.InstallationID)
	if err != nil {
		log.Errorw("auto_run_installation_not_found", "error", err)
		return
	}
	doneJob, err := a.jobRepo.GetLatestDoneForRepo(ctx, item.RepoID)
	if err != nil {
		log.Errorw("auto_run_commit_sha_unresolved", "error", err)
		return
	}

	branchName, branchHead := "", ""
	if a.publishRepo != nil {
		if b, bErr := a.publishRepo.GetBranchForWorkItem(ctx, item.ID); bErr == nil && b != nil {
			branchName = b.BranchName
			if b.HeadCommitSHA != nil {
				branchHead = *b.HeadCommitSHA
			}
		}
	}

	ws, err := a.wsManager.ReuseOrProvision(
		ctx, item.ID, repo.ID, repo.RepoFullName, doneJob.CommitSHA,
		branchName, branchHead, installation.GitHubInstallationID,
	)
	if err != nil {
		log.Errorw("auto_run_provision_failed", "error", err)
		return
	}
	if ws.Status != models.WorkspaceStatusReady {
		log.Errorw("auto_run_workspace_not_ready", "status", ws.Status)
		return
	}

	// 3. Create the execution and hand off to the orchestrator (which owns the
	//    rest of the lifecycle, including auto-validation and repair).
	plan, err := a.workItemRepo.GetActivePlan(ctx, taskID)
	if err != nil {
		log.Errorw("auto_run_no_active_plan", "error", err)
		return
	}

	traceID := "autorun-" + taskID
	execCtxModel := newExecutionContext(ws.ID, plan.Version, traceID, item.OrgID, item.UserID)
	execCtxJSON, _ := json.Marshal(execCtxModel)

	exec, err := a.execRepo.CreateExecution(ctx, taskID, ws.ID, plan.ID, json.RawMessage(execCtxJSON))
	if err != nil {
		log.Errorw("auto_run_create_execution_failed", "error", err)
		return
	}
	execCtxModel.TaskExecutionID = exec.ID
	execCtxJSON, _ = json.Marshal(execCtxModel)
	_, _ = a.execRepo.UpdateExecutionContext(ctx, exec.ID, execCtxJSON)

	_ = a.workItemRepo.TransitionToExecuting(ctx, taskID)

	log.Infow("auto_run_execution_started", "exec_id", exec.ID, "workspace_id", ws.ID)

	// Small settle delay so the transition + WS events flush before the
	// orchestrator's first status write races the plan_ready fan-out.
	time.Sleep(100 * time.Millisecond)
	go a.orchestrator.Run(context.Background(), exec.ID, plan.Body)
}
