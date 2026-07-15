package browserworkspace

import (
	"fmt"

	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// Handlers exposes REST endpoints for the browser workspace.
type Handlers struct {
	gateway     *Gateway
	fsService   *FilesystemService
	termService *TerminalService
	wsRepo      *repository.WorkspaceRepository
	workItemRepo *repository.WorkItemRepository
	wsManager   *workspace.WorkspaceManager
	logger      *zap.SugaredLogger
}

// NewHandlers creates browser workspace handlers.
func NewHandlers(
	gateway *Gateway,
	fsService *FilesystemService,
	termService *TerminalService,
	wsRepo *repository.WorkspaceRepository,
	workItemRepo *repository.WorkItemRepository,
	wsManager *workspace.WorkspaceManager,
	logger *zap.SugaredLogger,
) *Handlers {
	return &Handlers{
		gateway:      gateway,
		fsService:    fsService,
		termService:  termService,
		wsRepo:       wsRepo,
		workItemRepo: workItemRepo,
		wsManager:    wsManager,
		logger:       logger,
	}
}

// ── File Endpoints ───────────────────────────────────────────────────────────

// GetFileTree returns the directory structure.
// GET /v1/workspace/:workspaceID/files
func (h *Handlers) GetFileTree(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	tree, err := h.fsService.GetFileTree(ctx, workspaceID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("failed to list files: %v", err),
		})
	}

	return c.JSON(fiber.Map{"tree": tree})
}

// GetFileContent reads a single file.
// GET /v1/workspace/:workspaceID/files/*path
func (h *Handlers) GetFileContent(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	filePath := c.Params("*")
	ctx := c.Context()

	if filePath == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "path required"})
	}

	content, err := h.fsService.ReadFile(ctx, workspaceID, filePath)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"error": fmt.Sprintf("file not found: %v", err),
		})
	}

	return c.JSON(content)
}

// WriteFileContent writes a file (human edit).
// PUT /v1/workspace/:workspaceID/files/*path
func (h *Handlers) WriteFileContent(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	filePath := c.Params("*")
	ctx := c.Context()

	if filePath == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "path required"})
	}

	var body struct {
		Content string `json:"content"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}

	if err := h.fsService.WriteFile(ctx, workspaceID, filePath, []byte(body.Content)); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("write failed: %v", err),
		})
	}

	return c.JSON(fiber.Map{"written": len(body.Content)})
}

// ── Terminal Endpoints ────────────────────────────────────────────────────────

// CreateTerminal creates a new terminal session.
// POST /v1/workspace/:workspaceID/terminal
func (h *Handlers) CreateTerminal(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	var body struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := c.BodyParser(&body); err != nil || body.Cols == 0 || body.Rows == 0 {
		body.Cols = 120
		body.Rows = 30
	}

	session, err := h.termService.CreateSession(ctx, workspaceID, body.Cols, body.Rows)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err == ErrMaxTerminals {
			status = fiber.StatusTooManyRequests
		}
		return c.Status(status).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusCreated).JSON(session)
}

// CloseTerminal closes a terminal session.
// DELETE /v1/workspace/:workspaceID/terminal/:terminalID
func (h *Handlers) CloseTerminal(c *fiber.Ctx) error {
	terminalID := c.Params("terminalID")

	if err := h.termService.CloseSession(terminalID); err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"closed": terminalID})
}

// ── Git Endpoints ────────────────────────────────────────────────────────────

// GetGitStatus returns the git status of the workspace.
// GET /v1/workspace/:workspaceID/git/status
func (h *Handlers) GetGitStatus(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	// Run git status --porcelain inside the container
	events, err := h.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        []string{"git", "status", "--porcelain"},
		WorkingDir:     "",
		TimeoutSeconds: 10,
	})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("git status failed: %v", err),
		})
	}

	var output string
	for ev := range events {
		if ev.Type == "stdout" {
			output += string(ev.Data)
		}
	}

	// Parse porcelain output
	status := parseGitStatus(output)

	// Get current branch
	branchEvents, _ := h.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        []string{"git", "rev-parse", "--abbrev-ref", "HEAD"},
		WorkingDir:     "",
		TimeoutSeconds: 5,
	})
	var branch string
	for ev := range branchEvents {
		if ev.Type == "stdout" {
			branch += string(ev.Data)
		}
	}

	return c.JSON(fiber.Map{
		"branch":   trimNewline(branch),
		"modified": status.modified,
		"staged":   status.staged,
		"untracked": status.untracked,
	})
}

// GetGitDiff returns the unified diff for the workspace.
// GET /v1/workspace/:workspaceID/git/diff
func (h *Handlers) GetGitDiff(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	events, err := h.wsManager.Exec(ctx, workspaceID, workspace.ExecRequest{
		Command:        []string{"git", "diff"},
		WorkingDir:     "",
		TimeoutSeconds: 30,
	})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": fmt.Sprintf("git diff failed: %v", err),
		})
	}

	var output string
	for ev := range events {
		if ev.Type == "stdout" {
			output += string(ev.Data)
		}
	}

	return c.JSON(fiber.Map{"diff": output})
}

// ── Health Endpoint ──────────────────────────────────────────────────────────

// GetHealth returns workspace health metrics.
// GET /v1/workspace/:workspaceID/health
func (h *Handlers) GetHealth(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")
	ctx := c.Context()

	ws, err := h.wsRepo.GetByID(ctx, workspaceID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "workspace not found"})
	}

	terminals := h.termService.ListSessions(workspaceID)

	return c.JSON(fiber.Map{
		"container": fiber.Map{
			"status": ws.Status,
		},
		"workspace": fiber.Map{
			"status":           ws.Status,
			"active_terminals": len(terminals),
		},
	})
}

// ── Collaboration Endpoints ──────────────────────────────────────────────────

// PauseExecution pauses the current execution.
// POST /v1/workspace/:workspaceID/collaborate/pause
func (h *Handlers) PauseExecution(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")

	h.gateway.Publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
		"status":  "pausing",
		"message": "Pause requested — will pause after current step",
	})

	// TODO: Wire to Redis control queue (Phase 12 fully implements this)
	return c.JSON(fiber.Map{"status": "pausing"})
}

// ResumeExecution resumes a paused execution.
// POST /v1/workspace/:workspaceID/collaborate/resume
func (h *Handlers) ResumeExecution(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")

	h.gateway.Publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
		"status":  "running",
		"message": "Execution resumed",
	})

	// TODO: Wire to Redis control queue (Phase 12 fully implements this)
	return c.JSON(fiber.Map{"status": "running"})
}

// StopExecution stops the current execution.
// POST /v1/workspace/:workspaceID/collaborate/stop
func (h *Handlers) StopExecution(c *fiber.Ctx) error {
	workspaceID := c.Params("workspaceID")

	h.gateway.Publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
		"status":  "stopping",
		"message": "Stop requested",
	})

	// TODO: Wire to execution cancel (reuses Phase 7 mechanism)
	return c.JSON(fiber.Map{"status": "stopping"})
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type gitStatusResult struct {
	modified  []string
	staged    []string
	untracked []string
}

func parseGitStatus(output string) gitStatusResult {
	var result gitStatusResult
	lines := splitLines(output)
	for _, line := range lines {
		if len(line) < 4 {
			continue
		}
		status := line[:2]
		path := line[3:]
		switch {
		case status[0] == '?' && status[1] == '?':
			result.untracked = append(result.untracked, path)
		case status[0] != ' ' && status[0] != '?':
			result.staged = append(result.staged, path)
		case status[1] != ' ':
			result.modified = append(result.modified, path)
		}
	}
	return result
}

func splitLines(s string) []string {
	var lines []string
	for _, line := range split(s, "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func split(s, sep string) []string {
	result := make([]string, 0)
	for s != "" {
		idx := indexOf(s, sep)
		if idx < 0 {
			result = append(result, s)
			break
		}
		result = append(result, s[:idx])
		s = s[idx+len(sep):]
	}
	return result
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
