package validation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
)

// ParseStageRequest is the body sent to POST /v1/agent/parse-stage.
// One request per completed stage — not a batch of all stages.
type ParseStageRequest struct {
	ValidationRunID string        `json:"validation_run_id"`
	Stage           string        `json:"stage"`
	Stack           string        `json:"stack"`
	ExitCode        int           `json:"exit_code"`
	Stdout          string        `json:"stdout"`
	Stderr          string        `json:"stderr"`
	CombinedOutput  string        `json:"combined_output"`
	// RepoEvidence carries repository metadata gathered on stage failure.
	// Only populated when ExitCode != 0 — zero overhead on passing stages.
	RepoEvidence    *RepoEvidence `json:"repo_evidence,omitempty"`
}

// RepoEvidence is repository metadata collected by the orchestrator when a
// stage fails. It gives the agent's FailureDiagnosis enough context to
// distinguish environment failures from code failures.
type RepoEvidence struct {
	// Node.js
	NodeVersionFile        string `json:"node_version_file,omitempty"`        // .nvmrc / .node-version contents
	EnginesField           string `json:"engines_field,omitempty"`            // package.json "engines" as JSON
	NodeVersionInSandbox   string `json:"node_version_in_sandbox,omitempty"` // output of `node --version`
	// Python
	PythonRequires         string `json:"python_requires,omitempty"`
	// Go
	GoVersionInMod         string `json:"go_version_in_mod,omitempty"`
	// General
	LockfilePresent        bool   `json:"lockfile_present"`
	LockfileName           string `json:"lockfile_name,omitempty"`
}

// AgentParseClient calls POST /v1/agent/parse-stage (JSON, non-streaming).
// Parsing is fast — the agent returns structured diagnostics immediately.
type AgentParseClient struct {
	baseURL    string
	jwtSecret  string
	httpClient *http.Client
}

func NewAgentParseClient(baseURL, jwtSecret string) *AgentParseClient {
	return &AgentParseClient{
		baseURL:   baseURL,
		jwtSecret: jwtSecret,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// ParseStage sends one completed stage's output to the agent and returns
// the structured AgentParseResponse. Returns an error if the HTTP call
// fails; returns an empty response (no diagnostics) if the agent cannot
// parse the output — never propagates agent-side parse errors as fatal.
func (c *AgentParseClient) ParseStage(
	ctx context.Context,
	req ParseStageRequest,
) (*AgentParseResponse, error) {
	token, err := ingestion.SignJWT(map[string]interface{}{
		"sub": "backend",
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	}, c.jwtSecret)
	if err != nil {
		return nil, fmt.Errorf("sign JWT: %w", err)
	}

	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/agent/parse-stage", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+token)

	if traceID := ingestion.GetTraceID(ctx); traceID != "" {
		httpReq.Header.Set("X-Trace-ID", traceID)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("agent parse-stage request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		// Non-fatal — return empty result so validation continues.
		return &AgentParseResponse{StagePassed: req.ExitCode == 0}, fmt.Errorf(
			"agent returned %d: %s", resp.StatusCode, string(b))
	}

	var result AgentParseResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return &AgentParseResponse{StagePassed: req.ExitCode == 0}, nil
	}
	return &result, nil
}
