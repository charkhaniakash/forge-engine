package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/auth"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation"
)

// ValidationHandlers manages the validation lifecycle endpoints.
type ValidationHandlers struct {
	valRepo      *validation.ValidationRepository
	workItemRepo *repository.WorkItemRepository
	execRepo     *repository.ExecutionRepository
	orchestrator *validation.ValidationOrchestrator
	logger       *zap.SugaredLogger

	wsHub map[string]chan []byte
	wsMu  sync.RWMutex
}

func NewValidationHandlers(
	valRepo *validation.ValidationRepository,
	workItemRepo *repository.WorkItemRepository,
	execRepo *repository.ExecutionRepository,
	orchestrator *validation.ValidationOrchestrator,
	logger *zap.SugaredLogger,
) *ValidationHandlers {
	h := &ValidationHandlers{
		valRepo:      valRepo,
		workItemRepo: workItemRepo,
		execRepo:     execRepo,
		orchestrator: orchestrator,
		logger:       logger,
		wsHub:        make(map[string]chan []byte),
	}
	orchestrator.SetPublisher(h.publish)
	return h
}

// ── POST /v1/repos/:repoID/tasks/:taskID/validate ─────────────────────────────

func (h *ValidationHandlers) StartValidation(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	// Validation requires a completed execution.
	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "no execution found — run Phase 7 execution first",
		})
	}
	if exec.Status != "completed" && exec.Status != "failed" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": fmt.Sprintf("execution must be completed before validation (current: %s)", exec.Status),
		})
	}

	h.logger.Infow("validation_start_requested",
		"task_id", taskID, "exec_id", exec.ID,
		"workspace_id", exec.WorkspaceID, "trace_id", traceID)

	go func() {
		if _, err := h.orchestrator.Run(
			context.Background(),
			exec.ID, exec.WorkspaceID, traceID, "post_change",
		); err != nil {
			h.logger.Errorw("validation_run_failed",
				"task_id", taskID, "error", err, "trace_id", traceID)
		}
	}()

	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
		"task_id": item.ID,
		"status":  "validation_started",
	})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/validation ────────────────────────────

func (h *ValidationHandlers) GetValidation(c *fiber.Ctx) error {
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

	run, err := h.valRepo.GetLatestForTaskExecution(ctx, exec.ID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no validation run found"})
	}

	stages, _ := h.valRepo.ListStages(ctx, run.ID)
	return c.JSON(fiber.Map{"run": run, "stages": stages})
}

// ── GET /v1/repos/:repoID/tasks/:taskID/validation/diagnostics ───────────────

func (h *ValidationHandlers) GetDiagnostics(c *fiber.Ctx) error {
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

	run, err := h.valRepo.GetLatestForTaskExecution(ctx, exec.ID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no validation run found"})
	}

	diags, _ := h.valRepo.ListDiagnostics(ctx, run.ID)
	if diags == nil {
		diags = []*models.ValidationDiagnostic{}
	}
	return c.JSON(fiber.Map{"run_id": run.ID, "diagnostics": diags})
}

// ── WebSocket stream ──────────────────────────────────────────────────────────

func (h *ValidationHandlers) StreamUpgrade(c *fiber.Ctx) error {
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

func (h *ValidationHandlers) StreamWS(c *websocket.Conn) {
	taskID, _ := c.Locals("taskID").(string)
	ch := make(chan []byte, 256)
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

// ── Hub helpers ───────────────────────────────────────────────────────────────

func (h *ValidationHandlers) publish(runID, eventType string, payload map[string]interface{}) {
	// The WS hub is keyed by taskID but we only have runID here.
	// The orchestrator carries the runID; we look up by runID fallback.
	h.wsMu.RLock()
	// Try runID first, then fall back: the WS connection is registered by taskID
	// in StreamWS, but publication uses runID. For Phase 8, we broadcast to all
	// active WS connections since a task has at most one concurrent validation.
	for key, ch := range h.wsHub {
		_ = key
		event := map[string]interface{}{
			"v":          1,
			"event":      eventType,
			"run_id":     runID,
		}
		for k, v := range payload {
			event[k] = v
		}
		if raw, err := json.Marshal(event); err == nil {
			select {
			case ch <- raw:
			default:
			}
		}
	}
	h.wsMu.RUnlock()
}

func (h *ValidationHandlers) setWSChannel(key string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	h.wsHub[key] = ch
}

func (h *ValidationHandlers) removeWSChannel(key string) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if ch, ok := h.wsHub[key]; ok {
		close(ch)
		delete(h.wsHub, key)
	}
}
