package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/auth"
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// planTimeout is the maximum wall-clock time for a single planning call.
// Large repos with broad context may approach this ceiling.
const planTimeout = 10 * time.Minute

// TaskHandlers manages the work item + plan lifecycle.
//
// Ownership:
//   - Go: all status transitions, plan persistence, approval gate enforcement
//   - Agent: planning pipeline, context retrieval, LLM calls
//
// The approval gate is a hard constraint:
//   status cannot advance past 'plan_approved' without
//   approval_status IN ('approved', 'auto_approved').
//   This is enforced in Approve() and cannot be bypassed by the Agent.
type TaskHandlers struct {
	workItemRepo   *repository.WorkItemRepository
	jobRepo        *repository.IngestionJobRepository
	missionMsgRepo *repository.MissionMessageRepository
	agentClient    *ingestion.AgentPlanClient
	jwtSecret      string
	logger         *zap.SugaredLogger

	// autoRunHook, when set, is invoked (in a goroutine) once a task's plan is
	// ready AND the task is flagged auto_run. It performs the server-side
	// approve → provision → execute sequence. Wired in main.go, where the
	// execution/workspace services live, to keep this package decoupled.
	autoRunHook func(taskID string)

	// wsHub maps workItemID → channel of serialised WS messages.
	// Used to stream "thinking" events to the frontend during planning.
	wsHub map[string]chan []byte
	wsMu  sync.RWMutex

	// planEventLog buffers planning events per taskID so late-connecting
	// WebSocket subscribers receive the full history. Planning is fast (5-10s)
	// and the frontend often connects after it's already done.
	planEventLog   map[string][][]byte
	planEventLogMu sync.RWMutex
}

// NewTaskHandlers constructs TaskHandlers.
func NewTaskHandlers(
	workItemRepo *repository.WorkItemRepository,
	jobRepo *repository.IngestionJobRepository,
	missionMsgRepo *repository.MissionMessageRepository,
	agentClient *ingestion.AgentPlanClient,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *TaskHandlers {
	return &TaskHandlers{
		workItemRepo:   workItemRepo,
		jobRepo:        jobRepo,
		missionMsgRepo: missionMsgRepo,
		agentClient:    agentClient,
		jwtSecret:      jwtSecret,
		logger:         logger,
		wsHub:          make(map[string]chan []byte),
		planEventLog:   make(map[string][][]byte),
	}
}

// SetAutoRunHook wires the server-side auto-run sequence (approve → provision →
// execute), invoked when an auto_run task's plan becomes ready.
func (h *TaskHandlers) SetAutoRunHook(hook func(taskID string)) {
	h.autoRunHook = hook
}

// ── POST /v1/repos/:repoID/tasks ─────────────────────────────────────────────
// Creates a work item and immediately starts planning.

type CreateTaskRequest struct {
	Intent      string `json:"intent"`
	PlannerHint string `json:"planner_hint,omitempty"` // optional; defaults to "implementation"
	AutoRun     bool   `json:"auto_run,omitempty"`     // "Plan off" — skip review, run when ready
}

func (h *TaskHandlers) CreateTask(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(string)
	orgID := c.Locals("org_id").(string)
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var req CreateTaskRequest
	if err := c.BodyParser(&req); err != nil || req.Intent == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "intent is required"})
	}

	// Gate: repo must have a completed index (planning needs code context).
	doneJob, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository has not been indexed yet — run an index job first",
		})
	}

	// 1. Create work item in 'draft'.
	item, err := h.workItemRepo.Create(ctx, repoID, orgID, userID, req.Intent)
	if err != nil {
		h.logger.Errorw("task_create_failed", "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create task"})
	}

	// Persist auto-run intent (server is the source of truth, not the client).
	if req.AutoRun {
		if err := h.workItemRepo.SetAutoRun(ctx, item.ID, true); err != nil {
			h.logger.Warnw("task_set_auto_run_failed", "task_id", item.ID, "error", err)
		}
	}

	h.logger.Infow("task_created",
		"task_id", item.ID, "repo_id", repoID, "trace_id", traceID, "auto_run", req.AutoRun)

	// 2. Transition to 'planning' synchronously before returning,
	//    so the client immediately sees the right status.
	if err := h.workItemRepo.StartPlanning(ctx, item.ID); err != nil {
		h.logger.Errorw("task_start_planning_failed", "task_id", item.ID, "error", err)
		// Non-fatal for the response — return draft item.
		return c.Status(fiber.StatusCreated).JSON(item)
	}
	item.Status = models.WorkItemStatusPlanning

	// 3. Dispatch planning asynchronously — the frontend will stream
	//    "thinking" events via the WebSocket.
	plannerHint := req.PlannerHint
	if plannerHint == "" {
		plannerHint = "implementation"
	}

	go h.runPlanning(
		context.Background(), // detached from request context
		item.ID, doneJob.CommitSHA, plannerHint, traceID,
		nil, // no prior plan for first-time planning
		"",  // no refinement note
		nil, // no history for initial planning
	)

	return c.Status(fiber.StatusCreated).JSON(item)
}

// ── GET /v1/repos/:repoID/tasks ───────────────────────────────────────────────
// Lists work items for the repo.

func (h *TaskHandlers) ListTasks(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	repoID := c.Params("repoID")
	ctx := c.Context()

	items, err := h.workItemRepo.ListForRepo(ctx, repoID, orgID, 20, 0)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list tasks"})
	}
	if items == nil {
		items = []*models.WorkItem{}
	}
	return c.JSON(fiber.Map{"tasks": items})
}

// ── GET /v1/missions ──────────────────────────────────────────────────────────
// Lists recent work items (Missions) across the whole org — the primary object
// for the Mission-centric UI (sidebar + console), independent of any repo.

func (h *TaskHandlers) ListMissions(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	ctx := c.Context()

	items, err := h.workItemRepo.ListRecentByOrg(ctx, orgID, 30)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list missions"})
	}
	if items == nil {
		items = []*models.WorkItem{}
	}
	return c.JSON(fiber.Map{"missions": items})
}

// ── GET /v1/repos/:repoID/tasks/:taskID ──────────────────────────────────────
// Returns a work item with its active plan.

func (h *TaskHandlers) GetTask(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Attach the active plan if one exists.
	plan, _ := h.workItemRepo.GetActivePlan(ctx, taskID)

	autoRun, _ := h.workItemRepo.GetAutoRun(ctx, taskID)

	return c.JSON(fiber.Map{"task": item, "plan": plan, "auto_run": autoRun})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/plans ─────────────────────────────────
// Returns all plan versions for a work item.

func (h *TaskHandlers) ListPlans(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	// Verify the task belongs to this org.
	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	plans, err := h.workItemRepo.ListPlans(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list plans"})
	}
	if plans == nil {
		plans = []*models.Plan{}
	}
	return c.JSON(fiber.Map{"plans": plans})
}

// ── PUT /v1/repos/:repoID/tasks/:taskID/plan ──────────────────────────────────
// Submits a user-edited plan. Creates a new plan version, resets approval.

type UpdatePlanRequest struct {
	Body json.RawMessage `json:"body"` // full PlanSchema v1 object
}

func (h *TaskHandlers) UpdatePlan(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var req UpdatePlanRequest
	if err := c.BodyParser(&req); err != nil || len(req.Body) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "body is required"})
	}

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}
	if item.Status != models.WorkItemStatusPlanReady &&
		item.Status != models.WorkItemStatusPlanApproved {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "plan can only be edited when task is in plan_ready or plan_approved status",
		})
	}

	// Validate the submitted plan body (basic JSON schema check).
	if err := validatePlanBody(req.Body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Sprintf("invalid plan body: %v", err),
		})
	}

	// Store the new plan version (deactivates the previous one in a transaction).
	plan, err := h.workItemRepo.CreatePlan(ctx, taskID,
		"implementation", "implementation_planner_v1",
		req.Body, "user_edit")
	if err != nil {
		h.logger.Errorw("task_update_plan_failed", "task_id", taskID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to store plan"})
	}

	// Reset approval — user edit requires re-approval.
	if err := h.workItemRepo.ResetApprovalAfterEdit(ctx, taskID); err != nil {
		h.logger.Warnw("task_reset_approval_failed", "task_id", taskID, "error", err)
	}

	h.logger.Infow("task_plan_updated",
		"task_id", taskID, "plan_version", plan.Version, "trace_id", traceID)

	return c.JSON(fiber.Map{"plan": plan})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/approve ─────────────────────────────
// Approves the active plan. Enforces the hard approval gate.

func (h *TaskHandlers) ApproveTask(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	item, err := h.workItemRepo.Approve(ctx, taskID, orgID)
	if err != nil {
		h.logger.Warnw("task_approve_failed",
			"task_id", taskID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "cannot approve: task must be in plan_ready status",
		})
	}

	h.logger.Infow("task_approved",
		"task_id", taskID, "trace_id", traceID)

	return c.JSON(fiber.Map{"task": item})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/replan ───────────────────────────────
// Triggers re-planning. Resets status to 'planning' and dispatches the agent.

func (h *TaskHandlers) Replan(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Load the current active plan body to give the agent context for the re-plan.
	var priorPlanBody json.RawMessage
	if prior, err := h.workItemRepo.GetActivePlan(ctx, taskID); err == nil {
		priorPlanBody = prior.Body
	}

	doneJob, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository has not been indexed yet",
		})
	}

	if err := h.workItemRepo.ResetForReplan(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("cannot replan: %v", err),
		})
	}

	// Wipe the previous run's artifacts so this is a completely fresh cycle
	// (execution, diffs, validation, repair, publishing/PR all cleared). The
	// prior plan body was already captured above for planner context.
	if err := h.workItemRepo.ClearRunArtifactsForReplan(ctx, taskID); err != nil {
		// Non-fatal: re-planning can still proceed; stale artifacts would only
		// affect display and the publish idempotency check.
		h.logger.Warnw("replan_clear_artifacts_failed",
			"task_id", taskID, "error", err, "trace_id", traceID)
	}

	h.logger.Infow("task_replan_triggered",
		"task_id", taskID, "trace_id", traceID)

	go h.runPlanning(
		context.Background(),
		item.ID, doneJob.CommitSHA, "implementation", traceID,
		priorPlanBody,
		"", // replan is a fresh cycle, not a refinement
		nil, // no history for replan
	)

	// Return the updated item (now in 'planning' status).
	item.Status = models.WorkItemStatusPlanning
	item.ApprovalStatus = "pending_review"
	return c.JSON(fiber.Map{"task": item})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/refine ───────────────────────────────
// Tier 1 follow-up: refine the CURRENT plan with an extra instruction, without
// wiping the run. Unlike Replan (a destructive fresh cycle), Refine keeps the
// prior plan as context, layers the user's note on top, and re-plans in place.
// Only valid while the user is reviewing the plan (plan_ready).

type RefinePlanRequest struct {
	Note string `json:"note"`
}

func (h *TaskHandlers) RefinePlan(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var req RefinePlanRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Note) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "note is required"})
	}

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}
	// Tier 1 is plan-review refinement only: the plan must be awaiting the user's
	// decision. Refining after approval/execution is Tier 2 (iterate on results).
	if item.Status != models.WorkItemStatusPlanReady {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "the plan can only be refined while it is awaiting review (plan_ready)",
		})
	}

	// Prior plan gives the planner a starting point to adjust rather than discard.
	var priorPlanBody json.RawMessage
	if prior, err := h.workItemRepo.GetActivePlan(ctx, taskID); err == nil {
		priorPlanBody = prior.Body
	}

	doneJob, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository has not been indexed yet",
		})
	}

	// Non-destructive: back to planning + pending_review, but keep any artifacts.
	// (At plan_ready there are none, but ResetForReplan is the correct guarded
	// transition and deliberately does NOT clear run artifacts.)
	if err := h.workItemRepo.ResetForReplan(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("cannot refine: %v", err),
		})
	}

	h.logger.Infow("task_refine_triggered", "task_id", taskID, "trace_id", traceID)

	go h.runPlanning(
		context.Background(),
		item.ID, doneJob.CommitSHA, "implementation", traceID,
		priorPlanBody,
		req.Note,
		nil, // no history for plan refinement (uses refinement_note instead)
	)

	item.Status = models.WorkItemStatusPlanning
	item.ApprovalStatus = "pending_review"
	return c.JSON(fiber.Map{"task": item})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/follow-up ────────────────────────────
// Mission follow-up: sends a new user message in the same thread, resets the
// work item to planning, and re-plans using accumulated chat history.

type FollowUpRequest struct {
	Message string `json:"message"`
	AutoRun bool   `json:"auto_run,omitempty"` // "Plan off" — run this follow-up without review
}

func (h *TaskHandlers) FollowUp(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var req FollowUpRequest
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Message) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "message is required"})
	}

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Follow-up is only allowed from terminal or plan_ready states.
	allowed := map[string]bool{
		models.WorkItemStatusDone:      true,
		models.WorkItemStatusFailed:    true,
		models.WorkItemStatusCancelled: true,
		models.WorkItemStatusPlanReady: true,
	}
	if !allowed[item.Status] {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "follow-up is only available when the mission is done, failed, cancelled, or plan_ready",
		})
	}

	// Lazy backfill: if no messages exist yet, insert the original intent as turn 1.
	existing, err := h.missionMsgRepo.ListByWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load history"})
	}
	if len(existing) == 0 {
		if _, err := h.missionMsgRepo.Append(ctx, taskID, "user", item.Intent, 1); err != nil {
			h.logger.Warnw("follow_up_backfill_failed", "task_id", taskID, "error", err)
		}
	}

	// Determine the next turn number and append the follow-up message.
	latestTurn, err := h.missionMsgRepo.LatestTurnNumber(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to read turn number"})
	}
	nextTurn := latestTurn + 1

	msg, err := h.missionMsgRepo.Append(ctx, taskID, "user", strings.TrimSpace(req.Message), nextTurn)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to persist message"})
	}

	// Reset to planning state (preserves artifacts).
	if err := h.workItemRepo.ResetForReplan(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("cannot reset for follow-up: %v", err),
		})
	}

	// Update the work item intent to the latest follow-up message so the agent
	// plans for the NEW request, not the original one.
	if err := h.workItemRepo.UpdateIntent(ctx, taskID, strings.TrimSpace(req.Message)); err != nil {
		h.logger.Warnw("follow_up_update_intent_failed", "task_id", taskID, "error", err)
	}

	// Get the latest done ingestion job for commit SHA.
	doneJob, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository has not been indexed yet",
		})
	}

	// Get prior plan body if available.
	var priorPlanBody json.RawMessage
	if prior, err := h.workItemRepo.GetActivePlan(ctx, taskID); err == nil {
		priorPlanBody = prior.Body
	}

	// Build history turns for the agent.
	allMsgs, _ := h.missionMsgRepo.ListByWorkItem(ctx, taskID)
	var history []ingestion.HistoryTurn
	for _, m := range allMsgs {
		history = append(history, ingestion.HistoryTurn{Role: m.Role, Content: m.Content})
	}

	// Set this turn's auto-run intent (overwrites any prior turn's choice).
	if err := h.workItemRepo.SetAutoRun(ctx, taskID, req.AutoRun); err != nil {
		h.logger.Warnw("follow_up_set_auto_run_failed", "task_id", taskID, "error", err)
	}

	h.logger.Infow("task_follow_up_triggered",
		"task_id", taskID, "turn", nextTurn, "trace_id", traceID, "auto_run", req.AutoRun)

	go h.runPlanning(
		context.Background(),
		item.ID, doneJob.CommitSHA, "implementation", traceID,
		priorPlanBody,
		"", // no single refinement note — full history is passed instead
		history,
	)

	item.Status = models.WorkItemStatusPlanning
	item.ApprovalStatus = "pending_review"
	return c.JSON(fiber.Map{
		"task":        item,
		"turn_number": nextTurn,
		"message":     msg,
	})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/messages ──────────────────────────────
// Returns the full mission message history for a work item.

func (h *TaskHandlers) ListMessages(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	// Verify the task exists and belongs to the org.
	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	msgs, err := h.missionMsgRepo.ListByWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load messages"})
	}
	if msgs == nil {
		msgs = []*models.MissionMessage{}
	}
	return c.JSON(fiber.Map{"messages": msgs})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/cancel ───────────────────────────────
// Cancels a work item from any non-terminal state.

func (h *TaskHandlers) CancelTask(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	if err := h.workItemRepo.Cancel(ctx, taskID, orgID); err != nil {
		h.logger.Warnw("task_cancel_failed", "task_id", taskID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("cannot cancel: %v", err),
		})
	}

	h.logger.Infow("task_cancelled", "task_id", taskID, "trace_id", traceID)
	return c.JSON(fiber.Map{"status": "cancelled"})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/stream ────────────────────────────────
// WebSocket upgrade — streams "thinking" events during planning.

func (h *TaskHandlers) StreamUpgrade(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		tokenStr := c.Query("token")
		if tokenStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing token"})
		}
		claims, err := auth.VerifyUserToken(tokenStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		c.Locals("taskID", c.Params("taskID"))
		c.Locals("org_id", claims["org_id"])
		c.Locals("user_id", claims["sub"])
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

func (h *TaskHandlers) StreamWS(c *websocket.Conn) {
	taskID, _ := c.Locals("taskID").(string)

	ch := make(chan []byte, 256)
	h.setWSChannel(taskID, ch)
	defer h.removeWSChannel(taskID)

	// Replay buffered planning events so late subscribers catch up.
	h.planEventLogMu.RLock()
	replay := h.planEventLog[taskID]
	h.planEventLogMu.RUnlock()
	for _, msg := range replay {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}

	pingTicker := time.NewTicker(20 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-pingTicker.C:
			if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// ── Planning orchestration ────────────────────────────────────────────────────

// runPlanning is called as a goroutine. It orchestrates the full planning call:
//   1. Signs the agent JWT
//   2. Calls the agent plan endpoint (streaming NDJSON)
//   3. Fans "thinking" events to the WebSocket in real time
//   4. On "plan" event: validates + persists the plan, transitions status
//   5. On "error" event or timeout: transitions to planning_failed
func (h *TaskHandlers) runPlanning(
	ctx context.Context,
	taskID, commitSHA, plannerHint, traceID string,
	priorPlanBody json.RawMessage,
	refinementNote string,
	history []ingestion.HistoryTurn,
) {
	log := h.logger.With("task_id", taskID, "trace_id", traceID)

	// Load the work item to get repo_id and intent.
	item, err := h.workItemRepo.GetByIDInternal(ctx, taskID)
	if err != nil {
		log.Errorw("planning_load_task_failed", "error", err)
		return
	}

	agentToken, err := signPlanToken(taskID, h.jwtSecret)
	if err != nil {
		log.Errorw("planning_sign_token_failed", "error", err)
		_ = h.workItemRepo.MarkPlanningFailed(ctx, taskID, "failed to sign agent token")
		return
	}

	planReq := ingestion.PlanRequest{
		WorkItemID:    taskID,
		RepoID:        item.RepoID,
		CommitSHA:     commitSHA,
		Intent:         item.Intent,
		PlannerHint:    plannerHint,
		PriorPlanBody:  priorPlanBody,
		RefinementNote: refinementNote,
		History:        history,
		RequestID:      fmt.Sprintf("plan-%s", taskID[:8]),
	}

	planCtx, cancel := context.WithTimeout(ctx, planTimeout)
	defer cancel()
	planCtx = ingestion.WithTraceID(planCtx, traceID)

	// emitTerminal publishes a lifecycle event to the planning socket AFTER the
	// DB write + status transition has committed. The agent's raw "plan" event
	// is fanned mid-stream (before persistence) for live preview only; clients
	// must react to these committed terminal events, never to "plan".
	emitTerminal := func(eventType string) {
		raw, err := json.Marshal(map[string]interface{}{"event": eventType})
		if err != nil {
			return
		}

		// Buffer the terminal event for late subscribers.
		h.planEventLogMu.Lock()
		if buf := h.planEventLog[taskID]; len(buf) < 200 {
			h.planEventLog[taskID] = append(buf, raw)
		}
		h.planEventLogMu.Unlock()

		// Clean up the buffer after 2 minutes — planning is done.
		go func() {
			time.Sleep(2 * time.Minute)
			h.planEventLogMu.Lock()
			delete(h.planEventLog, taskID)
			h.planEventLogMu.Unlock()
		}()

		wsCh := h.getWSChannel(taskID)
		if wsCh == nil {
			return
		}
		select {
		case wsCh <- raw:
		default:
		}
	}

	var planBody json.RawMessage
	var planErr string
	var foundTerminal bool

	streamErr := h.agentClient.Plan(planCtx, planReq, agentToken,
		func(event ingestion.PlanStreamEvent) {
			// Fan every event to the WebSocket immediately.
			// Re-read the channel on every event so late-connecting subscribers
			// still receive events (previously captured once → nil if WS connected late).
			raw, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return
			}

			// Buffer for late subscribers (planning is fast, WS often connects after).
			h.planEventLogMu.Lock()
			if buf := h.planEventLog[taskID]; len(buf) < 200 {
				h.planEventLog[taskID] = append(buf, raw)
			}
			h.planEventLogMu.Unlock()

			wsCh := h.getWSChannel(taskID)
			if wsCh != nil {
				select {
				case wsCh <- raw:
				default:
				}
			}

			switch event.Event {
			case "thinking":
				log.Infow("planning_thinking",
					"stage", event.Stage, "message", event.Message)

			case "plan":
				foundTerminal = true
				planBody = event.Plan
				log.Infow("planning_plan_received",
					"body_len", len(planBody))

			case "error":
				foundTerminal = true
				planErr = event.Message
				log.Errorw("planning_agent_error", "message", event.Message)
			}
		},
	)

	if streamErr != nil {
		log.Errorw("planning_stream_error", "error", streamErr)
		_ = h.workItemRepo.MarkPlanningFailed(ctx, taskID,
			fmt.Sprintf("agent stream error: %v", streamErr))
		emitTerminal("planning_failed")
		return
	}

	if !foundTerminal || planErr != "" {
		msg := planErr
		if msg == "" {
			msg = "agent did not produce a plan"
		}
		_ = h.workItemRepo.MarkPlanningFailed(ctx, taskID, msg)
		emitTerminal("planning_failed")
		return
	}

	// Validate and persist the plan.
	if err := validatePlanBody(planBody); err != nil {
		log.Errorw("planning_validation_failed", "error", err)
		_ = h.workItemRepo.MarkPlanningFailed(ctx, taskID,
			fmt.Sprintf("plan validation failed: %v", err))
		emitTerminal("planning_failed")
		return
	}

	if _, err := h.workItemRepo.CreatePlan(ctx, taskID,
		"implementation", "implementation_planner_v1",
		planBody, "agent"); err != nil {
		log.Errorw("planning_persist_failed", "error", err)
		_ = h.workItemRepo.MarkPlanningFailed(ctx, taskID,
			fmt.Sprintf("failed to persist plan: %v", err))
		emitTerminal("planning_failed")
		return
	}

	if err := h.workItemRepo.MarkPlanReady(ctx, taskID); err != nil {
		log.Errorw("planning_mark_ready_failed", "error", err)
		emitTerminal("planning_failed")
		return
	}

	// Status is now committed as plan_ready — safe to tell the client.
	emitTerminal("plan_ready")
	log.Infow("planning_complete")

	// Auto-run ("Plan off"): skip the human review gate and run the pipeline
	// server-side. Fully backend-driven — no client needs to be present.
	if h.autoRunHook != nil {
		if autoRun, err := h.workItemRepo.GetAutoRun(ctx, taskID); err == nil && autoRun {
			log.Infow("auto_run_triggered", "task_id", taskID)
			go h.autoRunHook(taskID)
		}
	}
}

// ── Hub helpers ───────────────────────────────────────────────────────────────

func (h *TaskHandlers) setWSChannel(taskID string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	h.wsHub[taskID] = ch
}

func (h *TaskHandlers) getWSChannel(taskID string) chan []byte {
	h.wsMu.RLock()
	defer h.wsMu.RUnlock()
	return h.wsHub[taskID]
}

func (h *TaskHandlers) removeWSChannel(taskID string) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if ch, ok := h.wsHub[taskID]; ok {
		close(ch)
		delete(h.wsHub, taskID)
	}
}

// ── Plan validation ───────────────────────────────────────────────────────────

// validatePlanBody performs a lightweight server-side validation of a
// PlanSchema v1 body. It checks required top-level fields and that each
// step has the minimum required fields. Cycle detection for depends_on
// is also performed.
//
// This is a Go-side gate before any plan is persisted. It is intentionally
// simple — not a full JSON Schema validator. The Agent performs richer
// validation before emitting the plan event.
func validatePlanBody(body json.RawMessage) error {
	if len(body) == 0 {
		return fmt.Errorf("plan body is empty")
	}

	var plan map[string]interface{}
	if err := json.Unmarshal(body, &plan); err != nil {
		return fmt.Errorf("plan body is not valid JSON: %w", err)
	}

	// Required top-level fields.
	required := []string{"schema_version", "plan_type", "steps", "intent_summary"}
	for _, f := range required {
		if _, ok := plan[f]; !ok {
			return fmt.Errorf("plan body missing required field: %s", f)
		}
	}

	if sv, ok := plan["schema_version"].(string); !ok || sv != "v1" {
		return fmt.Errorf("plan body has unsupported schema_version (expected 'v1')")
	}

	// Validate steps array.
	stepsRaw, ok := plan["steps"].([]interface{})
	if !ok {
		return fmt.Errorf("plan body 'steps' must be an array")
	}
	if len(stepsRaw) == 0 {
		return fmt.Errorf("plan body must have at least one step")
	}

	// Check each step has required fields; collect step IDs for cycle check.
	stepIDs := make(map[string]bool)
	type stepRef struct {
		id        string
		dependsOn []string
	}
	var stepRefs []stepRef

	for i, raw := range stepsRaw {
		step, ok := raw.(map[string]interface{})
		if !ok {
			return fmt.Errorf("step %d is not an object", i)
		}

		stepRequired := []string{"id", "stable_id", "order", "title", "type"}
		for _, f := range stepRequired {
			if _, ok := step[f]; !ok {
				return fmt.Errorf("step %d missing required field: %s", i, f)
			}
		}

		sid, _ := step["id"].(string)
		if sid == "" {
			return fmt.Errorf("step %d has empty id", i)
		}
		if stepIDs[sid] {
			return fmt.Errorf("duplicate step id: %s", sid)
		}
		stepIDs[sid] = true

		var deps []string
		if raw, ok := step["depends_on"]; ok {
			if arr, ok := raw.([]interface{}); ok {
				for _, d := range arr {
					if ds, ok := d.(string); ok {
						deps = append(deps, ds)
					}
				}
			}
		}
		stepRefs = append(stepRefs, stepRef{id: sid, dependsOn: deps})
	}

	// Verify all depends_on references exist.
	for _, sr := range stepRefs {
		for _, dep := range sr.dependsOn {
			if !stepIDs[dep] {
				return fmt.Errorf("step %s depends_on unknown step id: %s", sr.id, dep)
			}
		}
	}

	// Cycle detection using DFS with colour marking.
	type colour int
	const (
		white colour = iota
		grey
		black
	)
	colours := make(map[string]colour)
	depMap := make(map[string][]string)
	for _, sr := range stepRefs {
		depMap[sr.id] = sr.dependsOn
	}

	var dfs func(id string) bool
	dfs = func(id string) bool {
		if colours[id] == black {
			return false
		}
		if colours[id] == grey {
			return true // cycle found
		}
		colours[id] = grey
		for _, dep := range depMap[id] {
			if dfs(dep) {
				return true
			}
		}
		colours[id] = black
		return false
	}

	for id := range stepIDs {
		if dfs(id) {
			return fmt.Errorf("plan steps contain a dependency cycle")
		}
	}

	return nil
}

// signPlanToken is a package-level helper used by TaskHandlers.
// It re-uses SignJWT from the ingestion package (same as Q&A).
func signPlanToken(workItemID, secret string) (string, error) {
	return ingestion.SignJWT(map[string]interface{}{
		"sub":          "backend",
		"work_item_id": workItemID,
		"iat":          time.Now().Unix(),
		"exp":          time.Now().Add(15 * time.Minute).Unix(),
	}, secret)
}
