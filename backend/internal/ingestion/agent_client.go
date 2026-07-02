package ingestion

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// ProgressEvent is one line of NDJSON streamed from the Agent's ingest endpoint.
type ProgressEvent struct {
	Event           string  `json:"event"`            // "progress" | "done" | "error"
	Stage           string  `json:"stage,omitempty"`  // cloning|parsing|chunking|embedding|persisting
	Processed       int     `json:"processed,omitempty"`
	Total           int     `json:"total,omitempty"`
	TotalChunks     int     `json:"total_chunks,omitempty"` // set on "done"
	Message         string  `json:"message,omitempty"`      // set on "error"
}

// IngestRequest is the JSON body sent to POST /v1/agent/ingest.
type IngestRequest struct {
	JobID     string `json:"job_id"`
	RepoID    string `json:"repo_id"`
	CommitSHA string `json:"commit_sha"`
	ClonePath string `json:"clone_path"`
}

// AgentClient sends ingestion jobs to the Python Agent and reads back the
// streaming NDJSON progress response.
type AgentClient struct {
	baseURL    string
	httpClient *http.Client
	jwtSecret  string // shared secret for Backend→Agent JWT (ADR 0001)
}

// NewAgentClient constructs an AgentClient.
// baseURL should be e.g. "http://agent:8000".
func NewAgentClient(baseURL string, jwtSecret string) *AgentClient {
	return &AgentClient{
		baseURL:   baseURL,
		jwtSecret: jwtSecret,
		httpClient: &http.Client{
			// No global timeout — the request is long-lived (streaming).
			// Per-request context deadlines are set by the caller.
			Timeout: 0,
		},
	}
}

// Ingest sends an ingest request to the Agent and calls onEvent for every
// progress line streamed back. It blocks until the Agent closes the response
// body or the context is cancelled.
//
// The caller is responsible for job status updates — this function only reads
// the stream and calls back.
func (c *AgentClient) Ingest(
	ctx context.Context,
	req IngestRequest,
	token string,
	onEvent func(ProgressEvent),
) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal ingest request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/v1/agent/ingest",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("failed to create ingest request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/x-ndjson")

	// Add a trace ID so logs correlate across services.
	if traceID := ctx.Value(contextKeyTraceID); traceID != nil {
		httpReq.Header.Set("X-Trace-ID", fmt.Sprintf("%v", traceID))
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("agent ingest request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("agent returned status %d: %s", resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 64*1024) // 64 KB line buffer

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		var event ProgressEvent
		if err := json.Unmarshal(line, &event); err != nil {
			// Malformed line — skip rather than abort the whole job.
			continue
		}

		onEvent(event)

		if event.Event == "done" || event.Event == "error" {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		// Context cancellation is expected during supersede; don't treat as error.
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("error reading agent response stream: %w", err)
	}

	return nil
}

// contextKey is an unexported type for context values to avoid collisions.
type contextKey string

const contextKeyTraceID contextKey = "trace_id"

// WithTraceID returns a context carrying a trace ID for the AgentClient to pick up.
func WithTraceID(ctx context.Context, traceID string) context.Context {
	return context.WithValue(ctx, contextKeyTraceID, traceID)
}

// GetTraceID retrieves the trace ID from a context, returning "" if absent.
func GetTraceID(ctx context.Context) string {
	if v := ctx.Value(contextKeyTraceID); v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}
