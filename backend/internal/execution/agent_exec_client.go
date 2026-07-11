package execution

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// StepRequest is the JSON body sent to POST /v1/agent/execute-step.
// Contains exactly one plan step and its full execution context.
// The agent never receives the full plan — only the step it must execute.
type StepRequest struct {
	Version          int                    `json:"version"`   // always 1
	ExecutionContext  models.ExecutionContext `json:"execution_context"`
	Step             map[string]interface{} `json:"step"`      // plan step object
	RequestID        string                 `json:"request_id"`
}

// ExecStreamEvent is one NDJSON line received from the agent's execute-step endpoint.
type ExecStreamEvent struct {
	Version         int             `json:"version"`
	Event           string          `json:"event"`
	RequestID       string          `json:"request_id"`
	StepID          string          `json:"step_id,omitempty"`

	// reasoning / deviation
	Message         string          `json:"message,omitempty"`

	// tool_call
	ToolName        string          `json:"tool,omitempty"`
	ToolArgs        json.RawMessage `json:"args,omitempty"`
	ToolCallID      string          `json:"tool_call_id,omitempty"` // idempotency key

	// tool_result (returned BY Go TO agent — agent echoes it back for logging)
	ToolResult      json.RawMessage `json:"result,omitempty"`
	Success         bool            `json:"success,omitempty"`

	// step_complete
	Summary         string          `json:"summary,omitempty"`

	// exec_complete
	ModifiedFiles   []string        `json:"modified_files,omitempty"`
}

// AgentExecClient sends a single-step execution request to the Python agent
// and streams ExecStreamEvents back via NDJSON.
type AgentExecClient struct {
	baseURL    string
	jwtSecret  string
	httpClient *http.Client
}

// NewAgentExecClient constructs an AgentExecClient.
func NewAgentExecClient(baseURL, jwtSecret string) *AgentExecClient {
	return &AgentExecClient{
		baseURL:   baseURL,
		jwtSecret: jwtSecret,
		httpClient: &http.Client{Timeout: 0},
	}
}

// ExecuteStep sends one step to the agent and calls onEvent for each NDJSON line.
// Blocks until the agent emits step_complete/exec_complete/error or the context is cancelled.
func (c *AgentExecClient) ExecuteStep(
	ctx context.Context,
	req StepRequest,
	token string,
	onEvent func(ExecStreamEvent),
) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal step request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/agent/execute-step", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/x-ndjson")
	if traceID := ingestion.GetTraceID(ctx); traceID != "" {
		httpReq.Header.Set("X-Trace-ID", traceID)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("agent execute-step request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("agent returned status %d: %s", resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event ExecStreamEvent
		if err := json.Unmarshal(line, &event); err != nil {
			continue
		}
		onEvent(event)
		if event.Event == "step_complete" || event.Event == "exec_complete" ||
			event.Event == "error" {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("reading agent stream: %w", err)
	}
	return nil
}
