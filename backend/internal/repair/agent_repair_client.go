package repair

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/llmcreds"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// RepairContext carries identity and configuration for one repair attempt.
type RepairContext struct {
	RepairSessionID  string  `json:"repair_session_id"`
	TaskExecutionID  string  `json:"task_execution_id"`
	WorkspaceID      string  `json:"workspace_id"`
	AttemptNumber    int     `json:"attempt_number"`
	TraceID          string  `json:"trace_id"`
	Model            string  `json:"model"`
	Temperature      float64 `json:"temperature"`
	MaxTokens        int     `json:"max_tokens"`
}

// RepairRequest is the JSON body sent to POST /v1/agent/repair.
// One request per attempt; Go starts a brand-new graph for each attempt.
type RepairRequest struct {
	Version                 int                              `json:"version"` // always 1
	RepairContext           RepairContext                    `json:"repair_context"`
	Diagnostics             []*models.ValidationDiagnostic   `json:"diagnostics"`
	PreviousAttemptSummaries []map[string]interface{}        `json:"previous_attempts"` // Go composes from DB
	RequestID               string                           `json:"request_id"`
}

// RepairStreamEvent is one NDJSON line received from the agent's /repair endpoint.
type RepairStreamEvent struct {
	Version  int    `json:"version"`
	Event    string `json:"event"`
	RequestID string `json:"request_id,omitempty"`

	// reasoning
	Message string `json:"message,omitempty"`

	// tool_call
	ToolName   string          `json:"tool,omitempty"`
	ToolArgs   json.RawMessage `json:"args,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"` // idempotency key

	// tool_result (echoed back from Go)
	ToolResult json.RawMessage `json:"result,omitempty"`
	Success    bool            `json:"success,omitempty"`

	// repair_complete
	AgentVersion  string   `json:"agent_version,omitempty"`
	Strategy      string   `json:"strategy,omitempty"`
	Confidence    float64  `json:"confidence,omitempty"`
	ModifiedFiles []string `json:"modified_files,omitempty"`
	Summary       string   `json:"summary,omitempty"`

	// cannot_repair
	CannotRepairReason string `json:"cannot_repair_reason,omitempty"`

	// error
	Error string `json:"error,omitempty"`
}

// AgentRepairClient sends a single-attempt repair request to the Python agent
// and streams RepairStreamEvents back via NDJSON.
type AgentRepairClient struct {
	baseURL    string
	jwtSecret  string
	httpClient *http.Client
}

// NewAgentRepairClient constructs an AgentRepairClient.
func NewAgentRepairClient(baseURL, jwtSecret string) *AgentRepairClient {
	return &AgentRepairClient{
		baseURL:    baseURL,
		jwtSecret:  jwtSecret,
		httpClient: &http.Client{Timeout: 0}, // streaming requires no timeout
	}
}

// Repair sends one repair attempt to the agent and calls onEvent for each NDJSON line.
// Blocks until the agent emits repair_complete/cannot_repair/error or the context is cancelled.
func (c *AgentRepairClient) Repair(
	ctx context.Context,
	req RepairRequest,
	token string,
	onEvent func(RepairStreamEvent),
) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal repair request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/agent/repair", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/x-ndjson")
	if traceID := ingestion.GetTraceID(ctx); traceID != "" {
		httpReq.Header.Set("X-Trace-ID", traceID)
	}
	llmcreds.ApplyHeadersFromContext(ctx, httpReq)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("agent repair request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("agent returned status %d: %s", resp.StatusCode, string(b))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 256*1024), 256*1024) // 256KB line buffer

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event RepairStreamEvent
		if err := json.Unmarshal(line, &event); err != nil {
			// Log but continue — allow agent to proceed even if one event is malformed
			continue
		}
		onEvent(event)

		// Terminal events
		if event.Event == "repair_complete" || event.Event == "cannot_repair" || event.Event == "error" {
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
