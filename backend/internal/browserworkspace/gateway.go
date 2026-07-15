package browserworkspace

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/auth"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// ── Constants ────────────────────────────────────────────────────────────────

const (
	GatewayChannelBufferSize = 512
	PingInterval             = 20 * time.Second
	SessionGracePeriod       = 5 * time.Minute
	MaxReplayEvents          = 500
)

// ── Channel Names ────────────────────────────────────────────────────────────

const (
	ChSystem        = "system"
	ChFilesystem    = "filesystem"
	ChTerminal      = "terminal"
	ChExecution     = "execution"
	ChValidation    = "validation"
	ChRepair        = "repair"
	ChPublishing    = "publishing"
	ChGit           = "git"
	ChDiagnostics   = "diagnostics"
	ChTimeline      = "timeline"
	ChAIActivity    = "ai_activity"
	ChCollaboration = "collaboration"
)

// DefaultSubscriptions are channels every client subscribes to on connect.
var DefaultSubscriptions = []string{
	ChSystem, ChFilesystem, ChAIActivity, ChCollaboration, ChTimeline,
}

// ── Envelope ─────────────────────────────────────────────────────────────────

// Envelope is the unified message format for all WebSocket communication.
type Envelope struct {
	Channel string      `json:"ch"`
	Event   string      `json:"ev"`
	Seq     int64       `json:"seq"`
	Ts      int64       `json:"ts"`
	Payload interface{} `json:"payload,omitempty"`
}

// ClientMessage is a message sent from the browser to the server.
type ClientMessage struct {
	Type     string          `json:"type"` // subscribe | unsubscribe | channel_msg | reconnect | ping
	Channels []string        `json:"channels,omitempty"`
	Ch       string          `json:"ch,omitempty"`
	Ev       string          `json:"ev,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	// Reconnect fields
	SessionID string           `json:"session_id,omitempty"`
	LastSeq   map[string]int64 `json:"last_seq,omitempty"`
}

// ── Browser Session ──────────────────────────────────────────────────────────

// BrowserSession represents one browser tab connected to a workspace.
type BrowserSession struct {
	ID            string
	WorkspaceID   string
	UserID        string
	OrgID         string
	Subscriptions map[string]bool
	LastSeq       map[string]int64
	SendCh        chan []byte
	Status        string // connected | disconnected
	CreatedAt     time.Time
	LastSeenAt    time.Time
}

// ── Gateway ──────────────────────────────────────────────────────────────────

// Gateway manages all WebSocket connections for browser workspace sessions.
// It multiplexes multiple channels over a single WebSocket connection per client.
type Gateway struct {
	sessions    map[string]*BrowserSession // sessionID → session
	workspaces  map[string][]string        // workspaceID → []sessionID
	globalSeq   atomic.Int64
	replayBuf   map[string][]Envelope      // workspaceID → recent events
	mu          sync.RWMutex
	replayMu    sync.RWMutex
	termService *TerminalService
	fsService   *FilesystemService
	watchers    map[string]context.CancelFunc // workspaceID → watcher cancel
	watcherMu   sync.Mutex
	wsRepo      *repository.WorkspaceRepository
	workItemRepo *repository.WorkItemRepository
	logger      *zap.SugaredLogger
}

// NewGateway creates a new workspace WebSocket gateway.
func NewGateway(
	wsRepo *repository.WorkspaceRepository,
	workItemRepo *repository.WorkItemRepository,
	logger *zap.SugaredLogger,
) *Gateway {
	return &Gateway{
		sessions:     make(map[string]*BrowserSession),
		workspaces:   make(map[string][]string),
		replayBuf:    make(map[string][]Envelope),
		watchers:     make(map[string]context.CancelFunc),
		wsRepo:       wsRepo,
		workItemRepo: workItemRepo,
		logger:       logger,
	}
}

// SetTerminalService wires the terminal service for handling terminal input.
func (g *Gateway) SetTerminalService(ts *TerminalService) {
	g.termService = ts
}

// SetFilesystemService wires the filesystem service for starting watchers.
func (g *Gateway) SetFilesystemService(fs *FilesystemService) {
	g.fsService = fs
}

// ── HTTP Handlers ────────────────────────────────────────────────────────────

// StreamUpgrade handles WebSocket upgrade for the workspace stream.
func (g *Gateway) StreamUpgrade(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		tokenStr := c.Query("token")
		if tokenStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing token"})
		}
		claims, err := auth.VerifyUserToken(tokenStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		c.Locals("workspace_id", c.Params("workspaceID"))
		c.Locals("org_id", claims["org_id"])
		c.Locals("user_id", claims["sub"])
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

// StreamWS handles the unified WebSocket connection for a workspace.
func (g *Gateway) StreamWS(conn *websocket.Conn) {
	workspaceID, _ := conn.Locals("workspace_id").(string)
	userID, _ := conn.Locals("user_id").(string)
	orgID, _ := conn.Locals("org_id").(string)

	session := &BrowserSession{
		ID:            uuid.New().String(),
		WorkspaceID:   workspaceID,
		UserID:        userID,
		OrgID:         orgID,
		Subscriptions: make(map[string]bool),
		LastSeq:       make(map[string]int64),
		SendCh:        make(chan []byte, GatewayChannelBufferSize),
		Status:        "connected",
		CreatedAt:     time.Now(),
		LastSeenAt:    time.Now(),
	}

	// Subscribe to defaults
	for _, ch := range DefaultSubscriptions {
		session.Subscriptions[ch] = true
	}

	g.registerSession(session)
	defer g.unregisterSession(session)

	g.logger.Infow("browser_workspace_connected",
		"session_id", session.ID, "workspace_id", workspaceID, "user_id", userID)

	// Send connected event
	g.sendToSession(session, Envelope{
		Channel: ChSystem,
		Event:   "connected",
		Seq:     g.nextSeq(),
		Ts:      time.Now().UnixMilli(),
		Payload: map[string]interface{}{
			"session_id":   session.ID,
			"workspace_id": workspaceID,
		},
	})

	// Start write pump
	done := make(chan struct{})
	go g.writePump(conn, session, done)

	// Read pump (blocks until connection closes)
	g.readPump(conn, session)

	close(done)
	g.logger.Infow("browser_workspace_disconnected",
		"session_id", session.ID, "workspace_id", workspaceID)
}

// ── Publish ──────────────────────────────────────────────────────────────────

// Publish sends an event to all sessions subscribed to the given channel for a workspace.
func (g *Gateway) Publish(workspaceID, channel, event string, payload interface{}) {
	env := Envelope{
		Channel: channel,
		Event:   event,
		Seq:     g.nextSeq(),
		Ts:      time.Now().UnixMilli(),
		Payload: payload,
	}

	// Buffer for replay
	g.replayMu.Lock()
	buf := g.replayBuf[workspaceID]
	if len(buf) >= MaxReplayEvents {
		// Drop oldest
		g.replayBuf[workspaceID] = append(buf[1:], env)
	} else {
		g.replayBuf[workspaceID] = append(buf, env)
	}
	g.replayMu.Unlock()

	// Broadcast to subscribers
	g.mu.RLock()
	sessionIDs := g.workspaces[workspaceID]
	g.mu.RUnlock()

	for _, sid := range sessionIDs {
		g.mu.RLock()
		sess, ok := g.sessions[sid]
		g.mu.RUnlock()
		if !ok {
			continue
		}
		if sess.Subscriptions[channel] {
			g.sendToSession(sess, env)
		}
	}
}

// ── Internal ─────────────────────────────────────────────────────────────────

func (g *Gateway) nextSeq() int64 {
	return g.globalSeq.Add(1)
}

func (g *Gateway) sendToSession(session *BrowserSession, env Envelope) {
	raw, err := json.Marshal(env)
	if err != nil {
		return
	}
	select {
	case session.SendCh <- raw:
	default:
		// Backpressure — drop for slow client
	}
}

func (g *Gateway) registerSession(session *BrowserSession) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sessions[session.ID] = session
	g.workspaces[session.WorkspaceID] = append(g.workspaces[session.WorkspaceID], session.ID)

	// Start file watcher on first subscriber for this workspace
	if len(g.workspaces[session.WorkspaceID]) == 1 && g.fsService != nil {
		g.watcherMu.Lock()
		if _, exists := g.watchers[session.WorkspaceID]; !exists {
			ctx, cancel := context.WithCancel(context.Background())
			g.watchers[session.WorkspaceID] = cancel
			g.fsService.StartWatcher(ctx, session.WorkspaceID)
		}
		g.watcherMu.Unlock()
	}
}

func (g *Gateway) unregisterSession(session *BrowserSession) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.sessions, session.ID)
	// Remove from workspace list
	sids := g.workspaces[session.WorkspaceID]
	for i, sid := range sids {
		if sid == session.ID {
			g.workspaces[session.WorkspaceID] = append(sids[:i], sids[i+1:]...)
			break
		}
	}
	if len(g.workspaces[session.WorkspaceID]) == 0 {
		delete(g.workspaces, session.WorkspaceID)
		// Stop file watcher when no subscribers remain
		g.watcherMu.Lock()
		if cancel, exists := g.watchers[session.WorkspaceID]; exists {
			cancel()
			delete(g.watchers, session.WorkspaceID)
		}
		g.watcherMu.Unlock()
	}
}

func (g *Gateway) writePump(conn *websocket.Conn, session *BrowserSession, done <-chan struct{}) {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-session.SendCh:
			if !ok {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func (g *Gateway) readPump(conn *websocket.Conn, session *BrowserSession) {
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var clientMsg ClientMessage
		if json.Unmarshal(msg, &clientMsg) != nil {
			continue
		}

		switch clientMsg.Type {
		case "subscribe":
			for _, ch := range clientMsg.Channels {
				session.Subscriptions[ch] = true
			}
			g.sendToSession(session, Envelope{
				Channel: ChSystem,
				Event:   "subscribed",
				Seq:     g.nextSeq(),
				Ts:      time.Now().UnixMilli(),
				Payload: map[string]interface{}{"channels": clientMsg.Channels},
			})

		case "unsubscribe":
			for _, ch := range clientMsg.Channels {
				delete(session.Subscriptions, ch)
			}

		case "reconnect":
			g.handleReconnect(session, clientMsg.LastSeq)

		case "ping":
			g.sendToSession(session, Envelope{
				Channel: ChSystem,
				Event:   "pong",
				Seq:     g.nextSeq(),
				Ts:      time.Now().UnixMilli(),
			})

		case "channel_msg":
			g.handleChannelMessage(session, clientMsg)
		}

		session.LastSeenAt = time.Now()
	}
}

func (g *Gateway) handleReconnect(session *BrowserSession, lastSeqs map[string]int64) {
	g.replayMu.RLock()
	buf := g.replayBuf[session.WorkspaceID]
	g.replayMu.RUnlock()

	for _, env := range buf {
		lastSeen, ok := lastSeqs[env.Channel]
		if ok && env.Seq <= lastSeen {
			continue
		}
		if session.Subscriptions[env.Channel] {
			g.sendToSession(session, env)
		}
	}

	g.sendToSession(session, Envelope{
		Channel: ChSystem,
		Event:   "reconnected",
		Seq:     g.nextSeq(),
		Ts:      time.Now().UnixMilli(),
		Payload: map[string]interface{}{"session_id": session.ID},
	})
}

func (g *Gateway) handleChannelMessage(session *BrowserSession, msg ClientMessage) {
	// Route channel messages to appropriate handlers
	// Terminal input, collaboration commands, etc.
	switch msg.Ch {
	case ChTerminal:
		// Will be handled by terminal service
		g.onTerminalInput(session, msg)
	case ChCollaboration:
		// Will be handled by collaboration service
		g.onCollaborationCommand(session, msg)
	}
}

// Placeholder handlers — will be wired to services
func (g *Gateway) onTerminalInput(session *BrowserSession, msg ClientMessage) {
	// Forward to terminal service — needs to be wired after construction
	if g.termService != nil {
		switch msg.Ev {
		case "input":
			g.termService.HandleInput(session, msg.Payload)
		case "resize":
			g.termService.HandleResize(msg.Payload)
		default:
			g.termService.HandleInput(session, msg.Payload)
		}
	}
}
func (g *Gateway) onCollaborationCommand(session *BrowserSession, msg ClientMessage) {}
