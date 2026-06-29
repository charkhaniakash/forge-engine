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
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// QAHandlers handles the Q&A session lifecycle and real-time streaming.
//
// Ownership:
//   - Go: session/message persistence, auth, repo-readiness gate, WS fan-out
//   - Agent: retrieval, context assembly, LLM streaming
//
// WebSocket pairing model:
//   The frontend opens a WebSocket on .../stream, then POSTs to .../ask.
//   The handler pairs them via a per-session buffered channel stored in wsHub.
//   Tokens from the Agent stream are sent to the channel → WS write goroutine.
//   If no WebSocket is open the stream still completes; the answer is persisted
//   and returned in the POST response body as a fallback.
type QAHandlers struct {
	qaRepo      *repository.QARepository
	jobRepo     *repository.IngestionJobRepository
	repoRepo    *repository.GitHubRepoRepository
	agentClient *ingestion.AgentQAClient
	jwtSecret   string
	logger      *zap.SugaredLogger

	// wsHub maps sessionID → channel of serialised WS messages.
	// Lifecycle: created on WS open, closed+removed on WS close.
	wsHub map[string]chan []byte
	wsMu  sync.RWMutex
}

// NewQAHandlers constructs QAHandlers.
func NewQAHandlers(
	qaRepo *repository.QARepository,
	jobRepo *repository.IngestionJobRepository,
	repoRepo *repository.GitHubRepoRepository,
	agentClient *ingestion.AgentQAClient,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *QAHandlers {
	return &QAHandlers{
		qaRepo:      qaRepo,
		jobRepo:     jobRepo,
		repoRepo:    repoRepo,
		agentClient: agentClient,
		jwtSecret:   jwtSecret,
		logger:      logger,
		wsHub:       make(map[string]chan []byte),
	}
}

// ── POST /v1/repos/:repoID/qa/sessions ───────────────────────────────────────
// Creates a new Q&A session pinned to the latest done snapshot for the repo.

func (h *QAHandlers) CreateSession(c *fiber.Ctx) error {
	userID := c.Locals("user_id").(string)
	orgID := c.Locals("org_id").(string)
	repoID := c.Params("repoID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	// Gate: repo must have at least one completed ingestion job.
	job, err := h.jobRepo.GetLatestDoneForRepo(ctx, repoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository has not been indexed yet — run an index job first",
		})
	}

	session, err := h.qaRepo.CreateSession(ctx, repoID, orgID, userID, job.CommitSHA)
	if err != nil {
		h.logger.Errorw("qa_create_session_failed",
			"repo_id", repoID, "error", err, "trace_id", traceID)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create session"})
	}

	h.logger.Infow("qa_session_created",
		"session_id", session.ID, "repo_id", repoID,
		"commit_sha", session.CommitSHA, "trace_id", traceID)

	return c.Status(fiber.StatusCreated).JSON(session)
}

// ── GET /v1/repos/:repoID/qa/sessions ────────────────────────────────────────
// Lists sessions for the repo, newest first, scoped to the caller's org.

func (h *QAHandlers) ListSessions(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	repoID := c.Params("repoID")
	ctx := c.Context()

	sessions, err := h.qaRepo.ListSessionsForRepo(ctx, repoID, orgID, 20, 0)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list sessions"})
	}
	if sessions == nil {
		sessions = []*models.QASession{}
	}
	return c.JSON(fiber.Map{"sessions": sessions})
}

// ── GET /v1/repos/:repoID/qa/sessions/:sessionID ─────────────────────────────
// Returns a session with its full message history.

func (h *QAHandlers) GetSession(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	sessionID := c.Params("sessionID")
	ctx := c.Context()

	session, err := h.qaRepo.GetSessionByID(ctx, sessionID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "session not found"})
	}

	messages, err := h.qaRepo.ListMessages(ctx, sessionID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load messages"})
	}
	if messages == nil {
		messages = []*models.QAMessage{}
	}

	return c.JSON(fiber.Map{"session": session, "messages": messages})
}

// ── POST /v1/repos/:repoID/qa/sessions/:sessionID/ask ────────────────────────
// Asks a question. Streams tokens to the paired WebSocket (if connected), then
// persists the user question and assistant answer atomically.

type AskRequest struct {
	Question  string `json:"question"`
	RequestID string `json:"request_id"` // client-generated UUID for WS correlation
}

func (h *QAHandlers) Ask(c *fiber.Ctx) error {
	orgID := c.Locals("org_id").(string)
	sessionID := c.Params("sessionID")
	traceID := c.Locals("trace_id").(string)
	ctx := c.Context()

	var req AskRequest
	if err := c.BodyParser(&req); err != nil || req.Question == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "question is required"})
	}
	if req.RequestID == "" {
		req.RequestID = fmt.Sprintf("req-%d", time.Now().UnixNano())
	}

	// Load and authorise session.
	session, err := h.qaRepo.GetSessionByID(ctx, sessionID, orgID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "session not found"})
	}

	// Retrieval gate: find the latest done job for this repo.
	// Also used to heal sessions whose commit_sha was stored as "" because
	// they were created before the UpdateCommitSHA fix (job_worker.go step 7a).
	doneJob, err := h.jobRepo.GetLatestDoneForRepo(ctx, session.RepoID)
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository index not available",
		})
	}

	// Heal: if the session's commit_sha is empty, update it to the resolved SHA
	// from the latest done job so retrieval works correctly.
	if session.CommitSHA == "" && doneJob.CommitSHA != "" {
		h.logger.Infow("qa_session_commit_sha_healed",
			"session_id", sessionID,
			"resolved_sha", doneJob.CommitSHA,
			"trace_id", traceID,
		)
		_ = h.qaRepo.HealCommitSHA(ctx, sessionID, doneJob.CommitSHA)
		session.CommitSHA = doneJob.CommitSHA
	}

	// If the job's commit_sha is still empty (ingestion completed before UpdateCommitSHA),
	// we cannot proceed with retrieval. The ingestion_jobs table must be backfilled.
	if session.CommitSHA == "" && doneJob.CommitSHA == "" {
		h.logger.Errorw("qa_session_commit_sha_empty",
			"session_id", sessionID,
			"job_id", doneJob.ID,
			"trace_id", traceID,
		)
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "repository snapshot not available - ingestion_jobs.commit_sha is empty",
		})
	}

	// Persist the user message first so history loading includes it for future turns.
	_, err = h.qaRepo.AddMessage(ctx, sessionID, "user", req.Question, nil, nil, nil, &req.RequestID)
	if err != nil {
		h.logger.Errorw("qa_persist_user_msg_failed", "session_id", sessionID, "error", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to persist message"})
	}

	// Set session title from the first question.
	if session.Title == nil {
		title := req.Question
		if len(title) > 120 {
			title = title[:120]
		}
		_ = h.qaRepo.SetSessionTitle(ctx, sessionID, title)
	}

	// Build history for the Agent (last 12 messages = 6 turns, excluding the
	// question we just persisted).
	historyMsgs, _ := h.qaRepo.RecentMessages(ctx, sessionID, 13)
	history := make([]ingestion.QAHistoryMessage, 0, len(historyMsgs))
	for _, m := range historyMsgs {
		if m.Role == "user" && m.Content == req.Question {
			continue // skip the message we just inserted
		}
		history = append(history, ingestion.QAHistoryMessage{
			Role:    m.Role,
			Content: m.Content,
		})
	}

	// Sign a short-lived Backend→Agent JWT.
	agentToken, err := signAgentJWT(sessionID, h.jwtSecret)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	wsCh := h.getWSChannel(sessionID)

	// Accumulate the full answer and capture the final done event.
	var answerBuf []byte
	var finalEvent ingestion.QAStreamEvent

	agentReq := ingestion.QARequest{
		SessionID: sessionID,
		RepoID:    session.RepoID,
		CommitSHA: session.CommitSHA,
		Question:  req.Question,
		RequestID: req.RequestID,
		History:   history,
	}

	agentCtx := ingestion.WithTraceID(ctx, traceID)

	streamErr := h.agentClient.Ask(agentCtx, agentReq, agentToken, func(event ingestion.QAStreamEvent) {
		// Fan to WebSocket immediately (non-blocking; slow client drops events
		// but the full answer is still persisted from answerBuf).
		if wsCh != nil {
			if raw, jsonErr := json.Marshal(event); jsonErr == nil {
				select {
				case wsCh <- raw:
				default:
				}
			}
		}
		switch event.Event {
		case "token":
			answerBuf = append(answerBuf, event.Text...)
		case "done":
			finalEvent = event
		}
	})

	if streamErr != nil {
		h.logger.Errorw("qa_agent_stream_failed",
			"session_id", sessionID, "error", streamErr, "trace_id", traceID)
		if len(answerBuf) > 0 {
			_, _ = h.persistAnswer(ctx, sessionID, string(answerBuf), finalEvent, req.RequestID)
		}
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"error": "agent stream failed"})
	}

	msg, err := h.persistAnswer(ctx, sessionID, string(answerBuf), finalEvent, req.RequestID)
	if err != nil {
		h.logger.Errorw("qa_persist_answer_failed", "session_id", sessionID, "error", err)
	}

	h.logger.Infow("qa_ask_complete",
		"session_id", sessionID,
		"request_id", req.RequestID,
		"token_count", finalEvent.TokenCount,
		"model", finalEvent.Model,
		"trace_id", traceID,
	)

	return c.JSON(fiber.Map{"message": msg, "request_id": req.RequestID})
}

// ── GET /v1/repos/:repoID/qa/sessions/:sessionID/stream ──────────────────────
// WebSocket upgrade check middleware — must be registered before StreamWS.
// The JWT is passed as ?token= because browsers cannot send custom headers
// on WebSocket connections.

func (h *QAHandlers) StreamUpgrade(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		// Validate the JWT from the query parameter before upgrading.
		// The middleware RequireAuth only reads the Authorization header,
		// so we do the auth check inline here.
		tokenStr := c.Query("token")
		if tokenStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing token"})
		}
		claims, err := auth.VerifyUserToken(tokenStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
		}
		orgID, _ := claims["org_id"].(string)
		userID, _ := claims["sub"].(string)
		c.Locals("sessionID", c.Params("sessionID"))
		c.Locals("org_id", orgID)
		c.Locals("user_id", userID)
		return c.Next()
	}
	return fiber.ErrUpgradeRequired
}

// StreamWS is the WebSocket handler registered with websocket.New().
// The frontend opens this connection before calling /ask so tokens are
// delivered in real time.
func (h *QAHandlers) StreamWS(c *websocket.Conn) {
	sessionID, _ := c.Locals("sessionID").(string)

	ch := make(chan []byte, 512)
	h.setWSChannel(sessionID, ch)
	defer h.removeWSChannel(sessionID)

	// Ping to keep the connection alive during long generations.
	pingTicker := time.NewTicker(20 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return // channel closed
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

// ── hub helpers ───────────────────────────────────────────────────────────────

func (h *QAHandlers) setWSChannel(sessionID string, ch chan []byte) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	h.wsHub[sessionID] = ch
}

func (h *QAHandlers) getWSChannel(sessionID string) chan []byte {
	h.wsMu.RLock()
	defer h.wsMu.RUnlock()
	return h.wsHub[sessionID]
}

func (h *QAHandlers) removeWSChannel(sessionID string) {
	h.wsMu.Lock()
	defer h.wsMu.Unlock()
	if ch, ok := h.wsHub[sessionID]; ok {
		close(ch)
		delete(h.wsHub, sessionID)
	}
}

// ── persistence helper ────────────────────────────────────────────────────────

func (h *QAHandlers) persistAnswer(
	ctx context.Context,
	sessionID, content string,
	finalEvent ingestion.QAStreamEvent,
	requestID string,
) (*models.QAMessage, error) {
	var citations interface{}
	if len(finalEvent.Citations) > 0 {
		var c interface{}
		if err := json.Unmarshal(finalEvent.Citations, &c); err == nil {
			citations = c
		}
	}

	var tokenCount *int
	if finalEvent.TokenCount > 0 {
		n := finalEvent.TokenCount
		tokenCount = &n
	}

	var model *string
	if finalEvent.Model != "" {
		s := finalEvent.Model
		model = &s
	}

	return h.qaRepo.AddMessage(
		ctx, sessionID, "assistant", content,
		citations, tokenCount, model, &requestID,
	)
}

// signAgentJWT creates a short-lived Backend→Agent JWT for Q&A calls.
func signAgentJWT(sessionID, secret string) (string, error) {
	return ingestion.SignJWT(map[string]interface{}{
		"sub":        "backend",
		"session_id": sessionID,
		"iat":        time.Now().Unix(),
		"exp":        time.Now().Add(10 * time.Minute).Unix(),
	}, secret)
}
