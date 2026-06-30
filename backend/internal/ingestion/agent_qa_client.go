package ingestion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// QAHistoryMessage is one turn of conversation history sent to the Agent.
type QAHistoryMessage struct {
	Role    string `json:"role"`    // "user" | "assistant"
	Content string `json:"content"`
}

// QARequest is the JSON body sent to POST /v1/agent/qa.
type QARequest struct {
	SessionID  string             `json:"session_id"`
	RepoID     string             `json:"repo_id"`
	CommitSHA  string             `json:"commit_sha"`
	Question   string             `json:"question"`
	RequestID  string             `json:"request_id"`
	History    []QAHistoryMessage `json:"history"`
}

// QAStreamEvent is one NDJSON line received from the Agent's QA endpoint.
//
// Event types:
//   "token"  — a single text token; fan to WebSocket immediately
//   "done"   — final event; Citations carries the source list
//   "error"  — terminal error; Message carries details
//
// All events carry Version=1, Seq (monotonically incrementing per stream),
// and RequestID for client-side correlation.
type QAStreamEvent struct {
	Version    int             `json:"v"`
	Event      string          `json:"event"`
	Seq        int             `json:"seq"`
	RequestID  string          `json:"request_id"`

	// token
	Text       string          `json:"text,omitempty"`

	// done
	Citations  json.RawMessage `json:"citations,omitempty"`
	Model      string          `json:"model,omitempty"`
	TokenCount int             `json:"token_count,omitempty"`

	// error
	Message    string          `json:"message,omitempty"`
}

// AgentQAClient sends Q&A requests to the Python Agent and reads back the
// streaming NDJSON response, calling onEvent for each line.
//
// This is intentionally separate from AgentClient (ingestion) — they serve
// different pipelines and may diverge.
type AgentQAClient struct {
	baseURL    string
	jwtSecret  string
	httpClient *http.Client
}

// NewAgentQAClient constructs an AgentQAClient.
// baseURL should be e.g. "http://agent:8000".
func NewAgentQAClient(baseURL, jwtSecret string) *AgentQAClient {
	return &AgentQAClient{
		baseURL:   baseURL,
		jwtSecret: jwtSecret,
		httpClient: &http.Client{
			// No global timeout — QA responses are streamed and duration varies.
			// The caller sets a per-request deadline via context.
			Timeout: 0,
		},
	}
}

// Ask sends a QARequest to the Agent and streams QAStreamEvents back by
// calling onEvent for each line. Blocks until the Agent closes the stream,
// the context is cancelled, or a terminal event (done/error) is received.
func (c *AgentQAClient) Ask(
	ctx context.Context,
	req QARequest,
	token string,
	onEvent func(QAStreamEvent),
) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal qa request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/v1/agent/qa",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("failed to create qa request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/x-ndjson")

	if traceID := ctx.Value(contextKeyTraceID); traceID != nil {
		httpReq.Header.Set("X-Trace-ID", fmt.Sprintf("%v", traceID))
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("agent qa request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("agent returned status %d: %s", resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 128*1024), 128*1024) // 128 KB — citations can be large

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		var event QAStreamEvent
		if err := json.Unmarshal(line, &event); err != nil {
			// Malformed line — skip rather than abort the session.
			continue
		}

		onEvent(event)

		if event.Event == "done" || event.Event == "error" {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("error reading agent qa stream: %w", err)
	}

	return nil
}

// signQAToken creates a short-lived JWT for a Backend→Agent QA call.
func signQAToken(sessionID, jwtSecret string) (string, error) {
	return SignJWT(map[string]interface{}{
		"sub":        "backend",
		"session_id": sessionID,
		"iat":        time.Now().Unix(),
		"exp":        time.Now().Add(10 * time.Minute).Unix(),
	}, jwtSecret)
}
