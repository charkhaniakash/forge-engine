package publishing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// GitHubPRClient handles Pull Request operations via the GitHub API.
type GitHubPRClient struct {
	httpClient   *http.Client
	tokenGetter  func(repoFullName string) (string, error)
	baseURL      string
}

// NewGitHubPRClient creates a new PR client.
// tokenGetter is a function that resolves a fresh installation token for a repo.
func NewGitHubPRClient(tokenGetter func(repoFullName string) (string, error)) *GitHubPRClient {
	baseURL := os.Getenv("GITHUB_API_URL")
	if baseURL == "" {
		baseURL = "https://api.github.com"
	}
	return &GitHubPRClient{
		httpClient:  &http.Client{Timeout: 30 * time.Second},
		tokenGetter: tokenGetter,
		baseURL:     baseURL,
	}
}

// CreatePRRequest is the input for creating a PR.
type CreatePRRequest struct {
	RepoFullName string
	Head         string
	Base         string
	Title        string
	Body         string
	Draft        bool
}

// CreatePRResult is the response from PR creation.
type CreatePRResult struct {
	ID      int64  `json:"id"`
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	State   string `json:"state"`
	HeadSHA string `json:"head_sha"`
}

// PRState is the synced state of a PR.
type PRState struct {
	State       string  `json:"state"`
	Mergeable   *bool   `json:"mergeable"`
	ReviewState *string `json:"review_state"`
}

// GetPushToken returns a fresh installation token for pushing.
func (c *GitHubPRClient) GetPushToken(ctx context.Context, repoFullName string) (string, error) {
	token, err := c.tokenGetter(repoFullName)
	if err != nil {
		return "", fmt.Errorf("get installation token: %w", err)
	}
	return token, nil
}

// CreatePR creates a Pull Request via the GitHub API.
func (c *GitHubPRClient) CreatePR(ctx context.Context, req CreatePRRequest) (*CreatePRResult, error) {
	token, err := c.tokenGetter(req.RepoFullName)
	if err != nil {
		return nil, fmt.Errorf("get token: %w", err)
	}

	payload := map[string]interface{}{
		"title": req.Title,
		"body":  req.Body,
		"head":  req.Head,
		"base":  req.Base,
		"draft": req.Draft,
	}
	body, _ := json.Marshal(payload)

	parts := strings.SplitN(req.RepoFullName, "/", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid repo name: %s", req.RepoFullName)
	}

	url := fmt.Sprintf("%s/repos/%s/%s/pulls", c.baseURL, parts[0], parts[1])
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/vnd.github+json")
	httpReq.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("create PR API call: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("create PR failed (status %d): %s", resp.StatusCode, string(respBody))
	}

	var ghPR struct {
		ID      int64  `json:"id"`
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
		Head    struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ghPR); err != nil {
		return nil, fmt.Errorf("decode PR response: %w", err)
	}

	return &CreatePRResult{
		ID:      ghPR.ID,
		Number:  ghPR.Number,
		HTMLURL: ghPR.HTMLURL,
		State:   ghPR.State,
		HeadSHA: ghPR.Head.SHA,
	}, nil
}

// GetPRState fetches the current state of a PR.
func (c *GitHubPRClient) GetPRState(ctx context.Context, repoFullName string, prNumber int) (*PRState, error) {
	token, err := c.tokenGetter(repoFullName)
	if err != nil {
		return nil, fmt.Errorf("get token: %w", err)
	}

	parts := strings.SplitN(repoFullName, "/", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid repo name: %s", repoFullName)
	}

	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d", c.baseURL, parts[0], parts[1], prNumber)
	httpReq, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)
	httpReq.Header.Set("Accept", "application/vnd.github+json")
	httpReq.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("get PR state: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get PR state failed (status %d)", resp.StatusCode)
	}

	var ghPR struct {
		State     string `json:"state"`
		Mergeable *bool  `json:"mergeable"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ghPR); err != nil {
		return nil, err
	}

	state := ghPR.State
	return &PRState{
		State:     state,
		Mergeable: ghPR.Mergeable,
	}, nil
}
