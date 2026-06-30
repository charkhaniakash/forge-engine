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

// PlanRequest is the JSON body sent to POST /v1/agent/plan.
type PlanRequest struct {
	WorkItemID      string          `json:"work_item_id"`
	RepoID          string          `json:"repo_id"`
	CommitSHA       string          `json:"commit_sha"`
	Intent          string          `json:"intent"`
	PlannerHint     string          `json:"planner_hint,omitempty"`     // optional; defaults to "implementation"
	PriorPlanBody   json.RawMessage `json:"prior_plan_body,omitempty"`  // JSON of previous plan for re-plans (raw JSON, not base64)
	RequestID       string          `json:"request_id"`
}

// PlanStreamEvent is one NDJSON line received from the Agent's plan endpoint.
//
// Event types:
//   "thinking" — progress during staged analysis; streamed to WS for live UI
//   "plan"     — terminal success event; Plan carries the full PlanSchema v1 body
//   "error"    — terminal failure
//
// All events carry Version=1, Seq, and RequestID (same protocol as Q&A).
type PlanStreamEvent struct {
	Version   int             `json:"v"`
	Event     string          `json:"event"`
	Seq       int             `json:"seq"`
	RequestID string          `json:"request_id"`

	// thinking
	Stage   string `json:"stage,omitempty"`   // intent_analysis|impact_analysis|arch_analysis|plan_generation
	Message string `json:"message,omitempty"`

	// plan (terminal success)
	Plan json.RawMessage `json:"plan,omitempty"` // full PlanSchema v1 body

	// error (terminal failure)
	// Message field reused for error description
}

// AgentPlanClient sends planning requests to the Python Agent and reads back
// the streaming NDJSON response, calling onEvent for each line.
type AgentPlanClient struct {
	baseURL    string
	jwtSecret  string
	httpClient *http.Client
}

// NewAgentPlanClient constructs an AgentPlanClient.
func NewAgentPlanClient(baseURL, jwtSecret string) *AgentPlanClient {
	return &AgentPlanClient{
		baseURL:   baseURL,
		jwtSecret: jwtSecret,
		httpClient: &http.Client{
			// No global timeout — planning can be slow for large repos.
			// The caller sets a per-request deadline via context.
			Timeout: 0,
		},
	}
}

// Plan sends a PlanRequest to the Agent and streams PlanStreamEvents back by
// calling onEvent for each line. Blocks until the Agent closes the stream,
// the context is cancelled, or a terminal event (plan/error) is received.
func (c *AgentPlanClient) Plan(
	ctx context.Context,
	req PlanRequest,
	token string,
	onEvent func(PlanStreamEvent),
) error {
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal plan request: %w", err)
	}

	// Log the outgoing request body (excluding sensitive data) for debugging
	if traceID := ctx.Value(contextKeyTraceID); traceID != nil {
		// Create a sanitized version for logging (exclude prior_plan_body which can be large)
		sanitizedReq := map[string]interface{}{
			"work_item_id": req.WorkItemID,
			"repo_id":     req.RepoID,
			"commit_sha":  req.CommitSHA,
			"intent":      req.Intent,
			"request_id":  req.RequestID,
		}
		if req.PlannerHint != "" {
			sanitizedReq["planner_hint"] = req.PlannerHint
		}
		if req.PriorPlanBody != nil {
			sanitizedReq["prior_plan_body"] = "<omitted>"
		}
		logBody, _ := json.Marshal(sanitizedReq)
		fmt.Printf("[DEBUG] Plan request body: %s\n", string(logBody))
	}

	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		c.baseURL+"/v1/agent/plan",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("failed to create plan request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/x-ndjson")

	if traceID := ctx.Value(contextKeyTraceID); traceID != nil {
		httpReq.Header.Set("X-Trace-ID", fmt.Sprintf("%v", traceID))
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("agent plan request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("agent returned status %d: %s", resp.StatusCode, string(b))
	}

	// 256 KB buffer — plan bodies can be large (many steps, risks, affected files).
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 256*1024), 256*1024)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}

		var event PlanStreamEvent
		if err := json.Unmarshal(line, &event); err != nil {
			// Malformed line — skip rather than abort.
			continue
		}

		onEvent(event)

		// "plan" and "error" are terminal events — stop reading after either.
		if event.Event == "plan" || event.Event == "error" {
			break
		}
	}

	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("error reading agent plan stream: %w", err)
	}

	return nil
}


