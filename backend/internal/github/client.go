package github

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// Client handles GitHub API interactions
type Client struct {
	httpClient    *http.Client
	webhookSecret string
	baseURL       string
}

// NewClient creates a new GitHub API client
func NewClient() (*Client, error) {
	webhookSecret := os.Getenv("GITHUB_WEBHOOK_SECRET")
	if webhookSecret == "" {
		return nil, fmt.Errorf("GITHUB_WEBHOOK_SECRET not set")
	}

	return &Client{
		httpClient:    &http.Client{Timeout: 30 * time.Second},
		webhookSecret: webhookSecret,
		baseURL:       "https://api.github.com",
	}, nil
}

// VerifyWebhookSignature verifies the GitHub webhook signature
func (c *Client) VerifyWebhookSignature(payload []byte, signatureHeader string) bool {
	if signatureHeader == "" {
		return false
	}

	// GitHub sends signature as "sha256=<hex>"
	if len(signatureHeader) < 7 || signatureHeader[:7] != "sha256=" {
		return false
	}

	signature := signatureHeader[7:]
	mac := hmac.New(sha256.New, []byte(c.webhookSecret))
	mac.Write(payload)
	expectedSignature := hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(signature), []byte(expectedSignature))
}

// GetInstallationToken fetches an installation access token for a GitHub installation
func (c *Client) GetInstallationToken(appJWT string, installationID int64) (*InstallationToken, error) {
	url := fmt.Sprintf("%s/app/installations/%d/access_tokens", c.baseURL, installationID)

	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+appJWT)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get installation token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get installation token: status %d, body: %s", resp.StatusCode, string(body))
	}

	var token InstallationToken
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return nil, fmt.Errorf("failed to decode token response: %w", err)
	}

	return &token, nil
}

// ListInstallationRepos lists repositories accessible by an installation
func (c *Client) ListInstallationRepos(installationToken string, installationID int64) ([]*Repository, error) {
    url := fmt.Sprintf("%s/installation/repositories", c.baseURL)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+installationToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list repos: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to list repos: status %d, body: %s", resp.StatusCode, string(body))
	}

	var response struct {
		Repositories []*Repository `json:"repositories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode repos response: %w", err)
	}

	return response.Repositories, nil
}

// Repository represents a GitHub repository
type Repository struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	FullName    string `json:"full_name"`
	Owner       Owner  `json:"owner"`
	Private     bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
}

// Owner represents a repository owner
type Owner struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// InstallationEvent represents a GitHub installation event
type InstallationEvent struct {
	Action       string       `json:"action"`
	Installation Installation  `json:"installation"`
	Sender       Sender       `json:"sender"`
}

// Installation represents a GitHub installation
type Installation struct {
	ID       int64  `json:"id"`
	Account  Account `json:"account"`
}

// Account represents a GitHub account
type Account struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// Sender represents the event sender
type Sender struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// ParseWebhookEvent parses a webhook event payload
func ParseWebhookEvent(payload []byte, eventType string) (interface{}, error) {
	switch eventType {
	case "installation", "installation_repositories":
		var event InstallationEvent
		if err := json.Unmarshal(payload, &event); err != nil {
			return nil, fmt.Errorf("failed to parse installation event: %w", err)
		}
		return &event, nil
	default:
		return nil, fmt.Errorf("unsupported event type: %s", eventType)
	}
}
