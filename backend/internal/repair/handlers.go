package repair

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/auth"
)

// Handlers exposes REST endpoints for repair sessions.
type Handlers struct {
	repo   *RepairRepository
	orch   *Orchestrator
	logger *zap.SugaredLogger

	// wsHub maps sessionID → (connID → send channel).
	// Multiple browser tabs or clients can subscribe to the same session simultaneously.
	// Each subscriber gets its own buffered channel; publish broadcasts to all of them.
	// Lifecycle: connID entry created on WS open, removed on WS close.
	wsHub map[string]map[string]chan []byte
	wsMu  sync.RWMutex
}

// NewHandlers constructs Handlers and wires the orchestrator's WS publisher.
func NewHandlers(repo *RepairRepository, orch *Orchestrator, logger *zap.SugaredLogger) *Handlers {
	h := &Handlers{
		repo:   repo,
		orch:   orch,
		logger: logger,
		wsHub:  make(map[string]map[string]chan []byte),
	}
	if orch != nil {
		orch.SetPublisher(h.publish)
	}
	return h
}

// GetSession handles GET /v1/repair/sessions/:id
func (h *Handlers) GetSession(c *fiber.Ctx) error {
	sessionID := c.Params("id")
	if sessionID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "session_id required",
		})
	}

	session, err := h.repo.GetSession(c.Context(), sessionID)
	if err != nil {
		h.logger.Errorw("get_repair_session_failed", "error", err, "session_id", sessionID)
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "session not found",
		})
	}

	return c.JSON(session)
}

// GetSessionByTaskExecution handles GET /v1/repair/sessions/by-task/:taskExecutionID
func (h *Handlers) GetSessionByTaskExecution(c *fiber.Ctx) error {
	taskExecID := c.Params("taskExecutionID")
	if taskExecID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "task_execution_id required",
		})
	}

	session, err := h.repo.GetLatestForTaskExecution(c.Context(), taskExecID)
	if err != nil {
		// Not an error if no repair session exists (repair might not have been triggered)
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": "no repair session found for task",
		})
	}

	return c.JSON(session)
}

// ListAttempts handles GET /v1/repair/sessions/:id/attempts
func (h *Handlers) ListAttempts(c *fiber.Ctx) error {
	sessionID := c.Params("id")
	if sessionID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "session_id required",
		})
	}

	attempts, err := h.repo.ListAttemptsForSession(c.Context(), sessionID)
	if err != nil {
		h.logger.Errorw("list_attempts_failed", "error", err, "session_id", sessionID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to list attempts",
		})
	}

	return c.JSON(fiber.Map{
		"attempts": attempts,
	})
}

// ListCheckpoints handles GET /v1/repair/sessions/:id/checkpoints
func (h *Handlers) ListCheckpoints(c *fiber.Ctx) error {
	sessionID := c.Params("id")
	if sessionID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "session_id required",
		})
	}

	checkpoints, err := h.repo.ListCheckpointsForSession(c.Context(), sessionID)
	if err != nil {
		h.logger.Errorw("list_checkpoints_failed", "error", err, "session_id", sessionID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to list checkpoints",
		})
	}

	return c.JSON(fiber.Map{
		"checkpoints": checkpoints,
	})
}

// ── WebSocket stream ──────────────────────────────────────────────────────────

// StreamUpgrade is the WebSocket upgrade middleware.
// The JWT is passed as ?token= because browsers cannot send custom headers
// on WebSocket connections.
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
		c.Locals("sessionID", c.Params("id"))
		c.Locals("org_id", claims["org_id"])
		c.Locals("user_id", claims["sub"])
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

// StreamWS is the WebSocket handler registered with websocket.New().
// Multiple concurrent subscribers for the same sessionID are fully supported —
// each gets its own buffered channel and is cleaned up independently on disconnect.
func (h *Handlers) StreamWS(c *websocket.Conn) {
	sessionID, _ := c.Locals("sessionID").(string)
	connID := uuid.New().String()

	h.logger.Infow("repair_ws_connected", "session_id", sessionID, "conn_id", connID)

	ch := make(chan []byte, 256)
	h.addWSSubscriber(sessionID, connID, ch)
	defer func() {
		h.removeWSSubscriber(sessionID, connID)
		h.logger.Infow("repair_ws_disconnected", "session_id", sessionID, "conn_id", connID)
	}()

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

// publish broadcasts a repair event to every active subscriber for this session.
// Subscribers whose channels are full (slow readers) are skipped — they are not blocked.
func (h *Handlers) publish(sessionID, eventType string, payload map[string]interface{}) {
	event := map[string]interface{}{
		"v":          1,
		"event":      eventType,
		"session_id": sessionID,
	}
	for k, v := range payload {
		event[k] = v
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}

	h.wsMu.RLock()
	defer h.wsMu.RUnlock()
	for _, ch := range h.wsHub[sessionID] {
		select {
		case ch <- raw:
		default:
			// Subscriber is a slow reader — skip rather than block the repair loop.
		}
	}
}

// addWSSubscriber registers a new subscriber channel for a session.
func (h *Handlers) addWSSubscriber(sessionID, connID string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if h.wsHub[sessionID] == nil {
		h.wsHub[sessionID] = make(map[string]chan []byte)
	}
	h.wsHub[sessionID][connID] = ch
}

// removeWSSubscriber removes and closes a subscriber's channel.
// When the last subscriber for a session disconnects, the session entry is also deleted.
func (h *Handlers) removeWSSubscriber(sessionID, connID string) {
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
