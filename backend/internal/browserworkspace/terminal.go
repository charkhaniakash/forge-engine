package browserworkspace

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// ── Terminal Models ──────────────────────────────────────────────────────────

// TerminalSession represents a persistent interactive shell inside the workspace container.
// Each session owns exactly one PTY-attached bash process with bidirectional stdin/stdout.
type TerminalSession struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspace_id"`
	Cols        uint16    `json:"cols"`
	Rows        uint16    `json:"rows"`
	Status      string    `json:"status"` // active | closed
	CreatedAt   time.Time `json:"created_at"`

	// Internal — not serialized
	cancel   context.CancelFunc
	pty      *workspace.InteractiveExec
	stdinMu  sync.Mutex // protects concurrent writes to PTY stdin
}

// TerminalInputPayload is the payload for terminal input from the browser.
type TerminalInputPayload struct {
	TerminalID string `json:"terminal_id"`
	Data       string `json:"data"`
}

// TerminalResizePayload is the payload for terminal resize from the browser.
type TerminalResizePayload struct {
	TerminalID string `json:"terminal_id"`
	Cols       uint16 `json:"cols"`
	Rows       uint16 `json:"rows"`
}

// ── Terminal Service ─────────────────────────────────────────────────────────

const MaxTerminalsPerWorkspace = 5

// TerminalService manages persistent PTY sessions inside workspace containers.
type TerminalService struct {
	driver   *workspace.WorkspaceManager
	gateway  *Gateway
	sessions map[string]*TerminalSession // terminalID → session
	mu       sync.RWMutex
	logger   *zap.SugaredLogger
}

// NewTerminalService creates a terminal service.
func NewTerminalService(driver *workspace.WorkspaceManager, gateway *Gateway, logger *zap.SugaredLogger) *TerminalService {
	return &TerminalService{
		driver:   driver,
		gateway:  gateway,
		sessions: make(map[string]*TerminalSession),
		logger:   logger,
	}
}

// CreateSession creates a new persistent interactive terminal session.
// It allocates a PTY inside the container and starts a bash shell.
func (ts *TerminalService) CreateSession(ctx context.Context, workspaceID string, cols, rows uint16) (*TerminalSession, error) {
	// Check limit
	ts.mu.RLock()
	count := 0
	for _, s := range ts.sessions {
		if s.WorkspaceID == workspaceID && s.Status == "active" {
			count++
		}
	}
	ts.mu.RUnlock()

	if count >= MaxTerminalsPerWorkspace {
		return nil, ErrMaxTerminals
	}

	termID := uuid.New().String()
	termCtx, cancel := context.WithCancel(context.Background())

	// Create interactive PTY exec inside the container
	pty, err := ts.driver.ExecInteractive(ctx, workspaceID, cols, rows)
	if err != nil {
		cancel()
		return nil, err
	}

	session := &TerminalSession{
		ID:          termID,
		WorkspaceID: workspaceID,
		Cols:        cols,
		Rows:        rows,
		Status:      "active",
		CreatedAt:   time.Now(),
		cancel:      cancel,
		pty:         pty,
	}

	ts.mu.Lock()
	ts.sessions[termID] = session
	ts.mu.Unlock()

	// Start reading output from the PTY and streaming to browser
	go ts.streamOutput(termCtx, session)

	// Notify browser
	ts.gateway.Publish(workspaceID, ChTerminal, "created", map[string]interface{}{
		"terminal_id": termID,
		"cols":        cols,
		"rows":        rows,
	})

	ts.logger.Infow("terminal_created",
		"terminal_id", termID, "workspace_id", workspaceID,
		"cols", cols, "rows", rows)

	return session, nil
}

// CloseSession closes a terminal session and kills the shell process.
func (ts *TerminalService) CloseSession(terminalID string) error {
	ts.mu.Lock()
	session, ok := ts.sessions[terminalID]
	if !ok {
		ts.mu.Unlock()
		return ErrTerminalNotFound
	}
	session.Status = "closed"
	ts.mu.Unlock()

	// Cancel context stops the output reader goroutine
	session.cancel()
	// Close the PTY connection (kills the shell)
	if session.pty != nil {
		session.pty.Close()
	}

	// Remove from map after PTY is closed — streamOutput will have exited
	// because pty.Stdout.Read returns error/EOF after Close().
	ts.mu.Lock()
	delete(ts.sessions, terminalID)
	ts.mu.Unlock()

	ts.gateway.Publish(session.WorkspaceID, ChTerminal, "closed", map[string]interface{}{
		"terminal_id": terminalID,
	})

	ts.logger.Infow("terminal_closed", "terminal_id", terminalID)
	return nil
}

// HandleInput writes raw bytes into the terminal's PTY stdin.
// This is the key difference from the MVP: bytes go directly to the persistent
// shell, so cd, export, interactive programs, Ctrl+C all work correctly.
func (ts *TerminalService) HandleInput(session *BrowserSession, payload json.RawMessage) {
	var input TerminalInputPayload
	if json.Unmarshal(payload, &input) != nil {
		return
	}

	ts.mu.RLock()
	term, ok := ts.sessions[input.TerminalID]
	ts.mu.RUnlock()

	if !ok || term.Status != "active" || term.pty == nil {
		return
	}

	if len(input.Data) == 0 {
		return
	}

	// Write directly to the PTY stdin — this is the persistent shell
	term.stdinMu.Lock()
	_, err := term.pty.Stdin.Write([]byte(input.Data))
	term.stdinMu.Unlock()

	if err != nil {
		ts.logger.Warnw("terminal_stdin_write_failed",
			"terminal_id", term.ID, "error", err)
	}
}

// HandleResize resizes the terminal PTY.
func (ts *TerminalService) HandleResize(payload json.RawMessage) {
	var resize TerminalResizePayload
	if json.Unmarshal(payload, &resize) != nil {
		return
	}

	ts.mu.RLock()
	term, ok := ts.sessions[resize.TerminalID]
	ts.mu.RUnlock()

	if !ok || term.Status != "active" || term.pty == nil {
		return
	}

	term.Cols = resize.Cols
	term.Rows = resize.Rows

	if err := term.pty.Resize(uint(resize.Cols), uint(resize.Rows)); err != nil {
		ts.logger.Warnw("terminal_resize_failed",
			"terminal_id", term.ID, "error", err)
	}
}

// GetSession returns a terminal session by ID.
func (ts *TerminalService) GetSession(terminalID string) *TerminalSession {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.sessions[terminalID]
}

// ListSessions returns all active terminal sessions for a workspace.
func (ts *TerminalService) ListSessions(workspaceID string) []*TerminalSession {
	ts.mu.RLock()
	defer ts.mu.RUnlock()

	var result []*TerminalSession
	for _, s := range ts.sessions {
		if s.WorkspaceID == workspaceID && s.Status == "active" {
			result = append(result, s)
		}
	}
	return result
}

// streamOutput continuously reads from the PTY stdout and publishes to the browser
// via the WebSocket gateway. Runs until context is cancelled or PTY EOF.
func (ts *TerminalService) streamOutput(ctx context.Context, session *TerminalSession) {
	buf := make([]byte, 32*1024) // 32KB read buffer

	for {
		if ctx.Err() != nil {
			return
		}

		n, err := session.pty.Stdout.Read(buf)
		if n > 0 {
			// Publish output to all subscribed browsers
			data := make([]byte, n)
			copy(data, buf[:n])
			ts.gateway.Publish(session.WorkspaceID, ChTerminal, "output", map[string]interface{}{
				"terminal_id": session.ID,
				"data":        string(data),
			})
		}
		if err != nil {
			if err == io.EOF || ctx.Err() != nil {
				// Shell exited or context cancelled — remove from sessions map
				ts.mu.Lock()
				session.Status = "closed"
				delete(ts.sessions, session.ID)
				ts.mu.Unlock()

				ts.gateway.Publish(session.WorkspaceID, ChTerminal, "closed", map[string]interface{}{
					"terminal_id": session.ID,
					"reason":      "shell_exited",
				})
				ts.logger.Infow("terminal_shell_exited", "terminal_id", session.ID)
				return
			}
			// Transient read error — log and exit
			ts.mu.Lock()
			session.Status = "closed"
			delete(ts.sessions, session.ID)
			ts.mu.Unlock()

			ts.logger.Warnw("terminal_read_error", "terminal_id", session.ID, "error", err)
			return
		}
	}
}

// ── Errors ───────────────────────────────────────────────────────────────────

type terminalError string

func (e terminalError) Error() string { return string(e) }

const (
	ErrMaxTerminals     = terminalError("maximum terminal sessions reached")
	ErrTerminalNotFound = terminalError("terminal session not found")
)
