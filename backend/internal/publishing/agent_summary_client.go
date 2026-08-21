package publishing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/llmcreds"
)

// AgentSummaryClient calls the Agent's summary endpoint for commit messages and PR descriptions.
type AgentSummaryClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewAgentSummaryClient creates a new agent summary client.
func NewAgentSummaryClient() *AgentSummaryClient {
	baseURL := os.Getenv("AGENT_BASE_URL")
	if baseURL == "" {
		baseURL = "http://forge-agent:8000"
	}
	return &AgentSummaryClient{
		httpClient: &http.Client{Timeout: 60 * time.Second},
		baseURL:    baseURL,
	}
}

// GenerateSummary calls the Agent to produce commit messages or PR descriptions.
func (c *AgentSummaryClient) GenerateSummary(ctx context.Context, req SummaryRequest) (*SummaryResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal summary request: %w", err)
	}

	url := fmt.Sprintf("%s/v1/agent/summarize", c.baseURL)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	llmcreds.ApplyHeadersFromContext(ctx, httpReq)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("agent summarize call: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("agent summarize failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result SummaryResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode summary response: %w", err)
	}

	return &result, nil
}
