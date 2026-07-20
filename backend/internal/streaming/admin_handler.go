package streaming

import (
	"github.com/gofiber/fiber/v2"
)

// AdminHandler exposes operational endpoints for the streaming platform.
// Protected by admin middleware in production.
type AdminHandler struct {
	metrics        *Metrics
	sessionManager *SessionManager
	replayBuffer   *ReplayBuffer
	eventStore     *EventStore
}

// NewAdminHandler creates the admin handler.
func NewAdminHandler(
	metrics *Metrics,
	sessionManager *SessionManager,
	replayBuffer *ReplayBuffer,
	eventStore *EventStore,
) *AdminHandler {
	return &AdminHandler{
		metrics:        metrics,
		sessionManager: sessionManager,
		replayBuffer:   replayBuffer,
		eventStore:     eventStore,
	}
}

// GetStats returns a summary of the streaming platform's current state.
// GET /admin/streaming/stats
func (h *AdminHandler) GetStats(c *fiber.Ctx) error {
	stats := make(map[string]interface{})

	// Metrics snapshot
	if h.metrics != nil {
		stats["metrics"] = h.metrics.Snapshot()
	}

	return c.JSON(stats)
}
