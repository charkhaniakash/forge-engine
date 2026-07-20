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
	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// ExecutionHandlers manages task execution lifecycle and streaming.
//
// Go owns orchestration. The agent owns per-step reasoning.
// This handler never calls the agent directly — it creates the execution,
// then the orchestrator goroutine drives the rest.
type ExecutionHandlers struct {
	execRepo     *repository.ExecutionRepository
	workItemRepo *repository.WorkItemRepository
	wsRepo       *repository.WorkspaceRepository
	repoRepo     *repository.GitHubRepoRepository
	orchestrator *execution.ExecutionOrchestrator
	wsManager    *workspace.WorkspaceManager
	jwtSecret    string
	logger       *zap.SugaredLogger

	// wsHub maps taskExecutionID → WS send channel.
	wsHub map[string]chan []byte
	wsMu  sync.RWMutex
}

// NewExecutionHandlers constructs ExecutionHandlers.
func NewExecutionHandlers(
	execRepo *repository.ExecutionRepository,
	workItemRepo *repository.WorkItemRepository,
	wsRepo *repository.WorkspaceRepository,
	repoRepo *repository.GitHubRepoRepository,
	orchestrator *execution.ExecutionOrchestrator,
	wsManager *workspace.WorkspaceManager,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *ExecutionHandlers {
	h := &ExecutionHandlers{
		execRepo:     execRepo,
		workItemRepo: workItemRepo,
		wsRepo:       wsRepo,
		repoRepo:     repoRepo,
		orchestrator: orchestrator,
		wsManager:    wsManager,
		jwtSecret:    jwtSecret,
		logger:       logger,
		wsHub:        make(map[string]chan []byte),
	}
	// Wire the publisher callback so the orchestrator can fan events to WS.
	orchestrator.SetPublisher(h.publish)
	return h
}

// ── POST /v1/repos/:repoID/tasks/:taskID/execute ─────────────────────────────
// Creates a task_execution and starts the orchestrator goroutine.

func (h *ExecutionHandlers) StartExecution(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Hard gate: must be approved before execution can start.
	if item.ApprovalStatus != "approved" && item.ApprovalStatus != "auto_approved" {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"error": "task must be approved before execution",
		})
	}
	if item.Status != models.WorkItemStatusPlanApproved {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("task must be in plan_approved status (current: %s)", item.Status),
		})
	}

	// Workspace must be ready.
	ws, err := h.wsRepo.GetByWorkItemID(ctx, taskID)
	if err != nil || ws.Status != models.WorkspaceStatusReady {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "a ready workspace is required — provision one first",
		})
	}

	// Load active plan.
	plan, err := h.workItemRepo.GetActivePlan(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "no active plan"})
	}

	// Build execution context (shared with the auto-run path).
	execCtxModel := newExecutionContext(ws.ID, plan.Version, traceID, orgID, item.UserID)
	execCtxJSON, _ := json.Marshal(execCtxModel)

	exec, err := h.execRepo.CreateExecution(ctx, taskID, ws.ID, plan.ID, json.RawMessage(execCtxJSON))
	if err != nil {
		h.logger.Errorw("create_execution_failed", "task_id", taskID, "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create execution"})
	}

	// Update execution context with the resolved execution ID.
	execCtxModel.TaskExecutionID = exec.ID
	execCtxJSON, _ = json.Marshal(execCtxModel)
	// Persist the updated context (with TaskExecutionID).
	_, _ = h.execRepo.UpdateExecutionContext(ctx, exec.ID, execCtxJSON)

	// Transition work item to executing.
	_ = h.workItemRepo.TransitionToExecuting(ctx, taskID)

	h.logger.Infow("execution_started",
		"exec_id", exec.ID, "task_id", taskID, "trace_id", traceID)

	// Launch the orchestrator goroutine — it owns the rest of the lifecycle.
	go h.orchestrator.Run(context.Background(), exec.ID, plan.Body)

	return c.Status(fiber.StatusAccepted).JSON(exec)
}

// ── GET /v1/repos/:repoID/tasks/:taskID/execution ─────────────────────────────

func (h *ExecutionHandlers) GetExecution(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no execution found"})
	}

	steps, _ := h.execRepo.ListStepExecutions(ctx, exec.ID)
	return c.JSON(fiber.Map{"execution": exec, "steps": steps})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/execution/events ─────────────────────

func (h *ExecutionHandlers) GetExecutionEvents(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no execution found"})
	}

	events, _ := h.execRepo.ListEvents(ctx, exec.ID)
	if events == nil {
		events = []*models.ExecutionEvent{}
	}
	return c.JSON(fiber.Map{"execution_id": exec.ID, "events": events})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/execution/diffs ──────────────────────

func (h *ExecutionHandlers) GetExecutionDiffs(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no execution found"})
	}

	diffs, _ := h.execRepo.ListDiffs(ctx, exec.ID)
	if diffs == nil {
		diffs = []*models.CodeDiff{}
	}
	return c.JSON(fiber.Map{"execution_id": exec.ID, "diffs": diffs})
}

// ── POST /v1/repos/:repoID/tasks/:taskID/cancel ───────────────────────────────

func (h *ExecutionHandlers) CancelExecution(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no execution found"})
	}

	_ = h.execRepo.MarkCancelled(ctx, exec.ID)
	return c.JSON(fiber.Map{"status": "cancelled", "execution_id": exec.ID})
}

// ── WebSocket stream ──────────────────────────────────────────────────────────

func (h *ExecutionHandlers) StreamUpgrade(c *fiber.Ctx) error {
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

func (h *ExecutionHandlers) StreamWS(c *websocket.Conn) {
	taskID, _ := c.Locals("taskID").(string)

	// Map by taskID for the publisher — the publisher resolves execution ID later.
	ch := make(chan []byte, 512)
	h.setWSChannel(taskID, ch)
	defer h.removeWSChannel(taskID)

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

// ── Tool dispatch ─────────────────────────────────────────────────────────────
// POST /v1/internal/workspaces/:workspaceID/tool
// Called by the agent (via internal JWT) to execute one tool call.

type ToolCallBody struct {
	Version          int                    `json:"version"`
	Tool             string                 `json:"tool"`
	Args             map[string]interface{} `json:"args"`
	Reasoning        string                 `json:"reasoning"`
	StepID           string                 `json:"step_id"`
	StepExecutionID  string                 `json:"step_execution_id"` // for diff persistence
	ToolCallID       string                 `json:"tool_call_id"` // idempotency key
	ExecID           string                 `json:"exec_id"`
}

func (h *ExecutionHandlers) ToolDispatch(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var body ToolCallBody
	if err := c.BodyParser(&body); err != nil || body.Tool == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "tool is required"})
	}
	if body.Version != 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Sprintf("unsupported tool API version %d (supported: 1)", body.Version),
		})
	}

	// Idempotency: if this tool_call_id was already executed, return cached result.
	if body.ToolCallID != "" && body.ExecID != "" {
		if cached, err := h.execRepo.GetEventByToolCallID(ctx, body.ExecID, body.ToolCallID); err == nil && cached != nil {
			return c.JSON(fiber.Map{
				"version":    1,
				"tool":       body.Tool,
				"success":    cached.Success,
				"result":     cached.ToolResult,
				"cached":     true,
				"duration_ms": cached.DurationMS,
			})
		}
	}

	// Validate against Phase 7 policy.
	pathArg, _ := body.Args["path"].(string)
	if pathArg != "" {
		pathArg = "/workspace/" + strings.TrimPrefix(pathArg, "/")
	}
	if err := execution.Phase7Policy.Validate(body.Tool, pathArg); err != nil {
		h.logger.Warnw("tool_dispatch_denied",
			"tool", body.Tool, "path", pathArg, "trace_id", traceID, "error", err)
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": err.Error()})
	}

	start := time.Now()
	result, execErr := h.dispatchTool(ctx, workspaceID, body, traceID)
	durationMS := int(time.Since(start).Milliseconds())

	success := execErr == nil
	var resultJSON json.RawMessage
	if result != nil {
		resultJSON, _ = json.Marshal(result)
	}
	var errMsg *string
	if execErr != nil {
		s := execErr.Error()
		errMsg = &s
	}

	// Persist the tool call event (handles idempotency via ON CONFLICT).
	if body.ExecID != "" {
		toolName := body.Tool
		toolArgsJSON, _ := json.Marshal(body.Args)
		callID := body.ToolCallID
		var callIDPtr *string
		if callID != "" {
			callIDPtr = &callID
		}
		_, _ = h.execRepo.AppendEvent(ctx, body.ExecID, nil,
			"tool_result", &toolName, toolArgsJSON, resultJSON, callIDPtr,
			errMsg, &success, &durationMS)
	}

	if execErr != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"version": 1, "tool": body.Tool, "success": false,
			"error": execErr.Error(), "duration_ms": durationMS,
		})
	}

	return c.JSON(fiber.Map{
		"version": 1, "tool": body.Tool, "success": true,
		"result": result, "duration_ms": durationMS,
	})
}

// dispatchTool routes the validated tool call to WorkspaceManager.
func (h *ExecutionHandlers) dispatchTool(
	ctx context.Context,
	workspaceID string,
	body ToolCallBody,
	traceID string,
) (interface{}, error) {
	args := body.Args

	switch body.Tool {
	case "read_file":
		path, _ := args["path"].(string)
		data, err := h.wsManager.ReadFile(ctx, workspaceID, path)
		if err != nil {
			return nil, err
		}
		return fiber.Map{"content": string(data), "bytes": len(data)}, nil

	case "write_file":
		path, _ := args["path"].(string)
		content, _ := args["content"].(string)
		// Compute diff before writing.
		oldData, _ := h.wsManager.ReadFile(ctx, workspaceID, path)
		diff := execution.ComputeUnifiedDiff(path, string(oldData), content)
		if err := h.wsManager.WriteFile(ctx, workspaceID, path, []byte(content)); err != nil {
			return nil, err
		}
		// Persist diff.
		if body.ExecID != "" {
			diffStr := diff.Unified
			_, _ = h.execRepo.CreateDiff(ctx, body.ExecID, body.StepExecutionID, path, "modify",
				nil, &diffStr, diff.LinesAdded, diff.LinesRemoved)
		}
		return fiber.Map{
			"bytes_written": len(content),
			"lines_added":   diff.LinesAdded,
			"lines_removed": diff.LinesRemoved,
		}, nil

	case "create_file":
		path, _ := args["path"].(string)
		content, _ := args["content"].(string)
		if err := h.wsManager.CreateFile(ctx, workspaceID, path, []byte(content)); err != nil {
			return nil, err
		}
		if body.ExecID != "" {
			_, _ = h.execRepo.CreateDiff(ctx, body.ExecID, body.StepExecutionID, path, "create",
				nil, nil, len(strings.Split(content, "\n")), 0)
		}
		return fiber.Map{"bytes_written": len(content)}, nil

	case "delete_file":
		path, _ := args["path"].(string)
		if err := h.wsManager.DeleteFile(ctx, workspaceID, path); err != nil {
			return nil, err
		}
		if body.ExecID != "" {
			_, _ = h.execRepo.CreateDiff(ctx, body.ExecID, body.StepExecutionID, path, "delete",
				nil, nil, 0, 0)
		}
		return fiber.Map{"deleted": path}, nil

	case "rename_file":
		oldPath, _ := args["old_path"].(string)
		newPath, _ := args["new_path"].(string)
		if err := h.wsManager.RenameFile(ctx, workspaceID, oldPath, newPath); err != nil {
			return nil, err
		}
		if body.ExecID != "" {
			_, _ = h.execRepo.CreateDiff(ctx, body.ExecID, body.StepExecutionID, newPath, "rename",
				&oldPath, nil, 0, 0)
		}
		return fiber.Map{"old_path": oldPath, "new_path": newPath}, nil

	case "list_dir":
		path, _ := args["path"].(string)
		if path == "" {
			path = "."
		}
		entries, err := h.wsManager.ListDir(ctx, workspaceID, path)
		if err != nil {
			return nil, err
		}
		return fiber.Map{"entries": entries, "count": len(entries)}, nil

	case "search_symbol":
		pattern, _ := args["pattern"].(string)
		dir, _ := args["dir"].(string)
		if dir == "" {
			dir = "."
		}
		results, err := h.wsManager.SearchSymbol(ctx, workspaceID, dir, pattern)
		if err != nil {
			return nil, err
		}
		return fiber.Map{"matches": results, "count": len(results)}, nil

	case "exists":
		path, _ := args["path"].(string)
		exists, err := h.wsManager.Exists(ctx, workspaceID, path)
		if err != nil {
			return nil, err
		}
		return fiber.Map{"exists": exists, "path": path}, nil

	case "stat":
		path, _ := args["path"].(string)
		stat, err := h.wsManager.Stat(ctx, workspaceID, path)
		if err != nil {
			return nil, err
		}
		return stat, nil

	default:
		return nil, fmt.Errorf("unknown tool: %s", body.Tool)
	}
}

// ── Hub helpers ───────────────────────────────────────────────────────────────

func (h *ExecutionHandlers) publish(execID string, event execution.ExecStreamEvent) {
	// The WS hub is keyed by taskID; we don't have taskID here.
	// Use execID as the WS key — the frontend connects with the exec ID.
	h.wsMu.RLock()
	ch, ok := h.wsHub[execID]
	h.wsMu.RUnlock()
	if !ok {
		return
	}
	if raw, err := json.Marshal(event); err == nil {
		select {
		case ch <- raw:
		default:
		}
	}
}

func (h *ExecutionHandlers) setWSChannel(key string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	h.wsHub[key] = ch
}

func (h *ExecutionHandlers) removeWSChannel(key string) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if ch, ok := h.wsHub[key]; ok {
		close(ch)
		delete(h.wsHub, key)
	}
}
