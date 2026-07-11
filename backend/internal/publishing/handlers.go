package publishing

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/auth"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// Handlers exposes REST + WebSocket endpoints for publishing.
type Handlers struct {
	repo         *Repository
	orch         *Orchestrator
	workItemRepo *repository.WorkItemRepository
	execRepo     *repository.ExecutionRepository
	wsRepo       *repository.WorkspaceRepository
	repoRepo     *repository.GitHubRepoRepository
	logger       *zap.SugaredLogger

	// WebSocket hub: sessionID → (connID → send channel)
	wsHub    map[string]map[string]chan []byte
	wsMu     sync.RWMutex
	eventLog map[string][][]byte
	eventMu  sync.RWMutex
}

// NewHandlers creates publishing handlers and wires the WS publisher.
func NewHandlers(
	repo *Repository,
	orch *Orchestrator,
	workItemRepo *repository.WorkItemRepository,
	execRepo *repository.ExecutionRepository,
	wsRepo *repository.WorkspaceRepository,
	repoRepo *repository.GitHubRepoRepository,
	logger *zap.SugaredLogger,
) *Handlers {
	h := &Handlers{
		repo:         repo,
		orch:         orch,
		workItemRepo: workItemRepo,
		execRepo:     execRepo,
		wsRepo:       wsRepo,
		repoRepo:     repoRepo,
		logger:       logger,
		wsHub:        make(map[string]map[string]chan []byte),
		eventLog:     make(map[string][][]byte),
	}
	if orch != nil {
		orch.SetPublisher(h.publish)
	}
	return h
}

// StartPublish handles POST /v1/repos/:repoID/tasks/:taskID/publish
func (h *Handlers) StartPublish(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	userID := c.Locals("user_id").(string)
	taskID := c.Params("taskID")
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	// Validate UUID format to catch route mismatches early
	if !isValidUUID(taskID) || !isValidUUID(repoID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid task_id or repo_id format",
		})
	}

	// Verify task is in a publishable state
	item, err := h.workItemRepo.GetByID(ctx, taskID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	if item.Status != "done" && item.Status != "plan_approved" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "task must be in done state (validated) before publishing",
		})
	}

	// Get execution
	exec, err := h.execRepo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "no execution found for task",
		})
	}

	// Get workspace
	ws, err := h.wsRepo.GetByWorkItemID(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "no workspace found for task",
		})
	}

	// Load repo metadata for push/PR operations
	ghRepo, err := h.repoRepo.GetByID(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "repo not found"})
	}

	var reqBody struct {
		DraftMode bool `json:"draft_mode"`
	}
	if err := c.BodyParser(&reqBody); err != nil && len(c.Body()) > 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Sprintf("malformed request body: %v", err),
		})
	}

	publishReq := PublishRequest{
		WorkItemID:      taskID,
		TaskExecutionID: exec.ID,
		WorkspaceID:     ws.ID,
		RepoFullName:    ghRepo.RepoFullName,
		DefaultBranch:   ghRepo.DefaultBranch,
		BaseCommitSHA:   ws.CommitSHA,
		DraftMode:       reqBody.DraftMode,
		UserID:          userID,
		TraceID:         traceID,
	}

	// Check for existing session (idempotent)
	existingSession, _ := h.repo.GetLatestForWorkItem(ctx, taskID)
	if existingSession != nil {
		switch existingSession.Status {
		case StatusCompleted:
			return c.JSON(fiber.Map{
				"session": existingSession,
				"message": "already published",
			})
		case StatusFailed, StatusCancelled:
			// Allow retry — a new session will be created below
		default:
			// Session is in-progress (pending/verifying/branching/committing/pushing/creating_pr/syncing)
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"error":   "publishing already in progress",
				"session": existingSession,
			})
		}
	}

	// Launch publishing asynchronously
	// The partial unique index (idx_publishing_sessions_active_work_item) prevents
	// duplicate active sessions at the DB level as a final safety net.
	go func() {
		// Final safety check — reject if work_item_id is corrupted
		if !isValidUUID(publishReq.WorkItemID) {
			h.logger.Errorw("publishing_aborted_invalid_work_item_id",
				"work_item_id", publishReq.WorkItemID, "trace_id", traceID)
			return
		}
		if err := h.orch.Run(context.Background(), publishReq); err != nil {
			h.logger.Errorw("publishing_failed",
				"task_id", publishReq.WorkItemID, "error", err, "trace_id", traceID)
		}
	}()

	// Return immediately — frontend subscribes via WebSocket
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
		"status":  "publishing_started",
		"task_id": taskID,
		"repo_id": repoID,
	})
}

// GetPublishSession handles GET /v1/repos/:repoID/tasks/:taskID/publish
func (h *Handlers) GetPublishSession(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	taskID := c.Params("taskID")
	ctx := c.Context()

	// Validate UUID format
	if !isValidUUID(taskID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid task_id format",
		})
	}

	if _, err := h.workItemRepo.GetByID(ctx, taskID, orgID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "task not found"})
	}

	session, err := h.repo.GetLatestForWorkItem(ctx, taskID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "no publishing session found"})
	}

	return c.JSON(fiber.Map{"session": session})
}

// ── WebSocket ───────────────────────────────────────────────────────────────

// StreamUpgrade handles WebSocket upgrade for publishing progress.
func (h *Handlers) StreamUpgrade(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		tokenStr := c.Query("token")
		if tokenStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing token"})
		}
		claims, err := auth.VerifyUserToken(tokenStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		c.Locals("sessionID", c.Params("sessionID"))
		c.Locals("org_id", claims["org_id"])
		c.Locals("user_id", claims["sub"])
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

// StreamWS handles the WebSocket connection for publishing progress.
func (h *Handlers) StreamWS(c *websocket.Conn) {
	sessionID, _ := c.Locals("sessionID").(string)
	connID := uuid.New().String()

	h.logger.Infow("publishing_ws_connected", "session_id", sessionID, "conn_id", connID)

	ch := make(chan []byte, WSChannelBufferSize)
	h.addSubscriber(sessionID, connID, ch)
	defer func() {
		h.removeSubscriber(sessionID, connID)
		h.logger.Infow("publishing_ws_disconnected", "session_id", sessionID, "conn_id", connID)
	}()

	// Replay buffered events
	h.eventMu.RLock()
	replay := h.eventLog[sessionID]
	h.eventMu.RUnlock()
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

// ── Hub helpers ─────────────────────────────────────────────────────────────

func (h *Handlers) publish(sessionID, eventType string, payload map[string]interface{}) {
	event := map[string]interface{}{
		"v":          1,
		"event":      eventType,
		"session_id": sessionID,
	}
	for k, v := range payload {
		event[k] = v
	}
	if _, ok := event["ts"]; !ok {
		event["ts"] = time.Now().UnixMilli()
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}

	// Buffer for late subscribers
	h.eventMu.Lock()
	if buf := h.eventLog[sessionID]; len(buf) < EventReplayBufferMax {
		h.eventLog[sessionID] = append(buf, raw)
	}
	if eventType == "publishing_complete" {
		go func() {
			time.Sleep(EventReplayCleanupDelay)
			h.eventMu.Lock()
			delete(h.eventLog, sessionID)
			h.eventMu.Unlock()
		}()
	}
	h.eventMu.Unlock()

	// Broadcast to subscribers
	h.wsMu.RLock()
	defer h.wsMu.RUnlock()
	for _, ch := range h.wsHub[sessionID] {
		select {
		case ch <- raw:
		default:
		}
	}
}

func (h *Handlers) addSubscriber(sessionID, connID string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if h.wsHub[sessionID] == nil {
		h.wsHub[sessionID] = make(map[string]chan []byte)
	}
	h.wsHub[sessionID][connID] = ch
}

func (h *Handlers) removeSubscriber(sessionID, connID string) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	subs, ok := h.wsHub[sessionID]
	if !ok {
		return
	}
	if ch, exists := subs[connID]; exists {
		close(ch)
		delete(subs, connID)
	}
	if len(subs) == 0 {
		delete(h.wsHub, sessionID)
	}
}

// isValidUUID checks whether a string is a valid UUID v4 format.
// Used to reject corrupted route params before they reach the database.
func isValidUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}
