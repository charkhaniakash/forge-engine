package llmcreds

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var ErrNotConfigured = errors.New("no LLM provider configured — add an API key in Settings")

type Service struct {
	repo      *Repository
	agentURL  string
	jwtSecret string
	http      *http.Client
}

func NewService(repo *Repository, agentURL, jwtSecret string) *Service {
	if agentURL == "" {
		agentURL = os.Getenv("AGENT_URL")
	}
	if agentURL == "" {
		agentURL = "http://agent:8000"
	}
	return &Service{
		repo:      repo,
		agentURL:  strings.TrimRight(agentURL, "/"),
		jwtSecret: jwtSecret,
		http:      &http.Client{Timeout: 30 * time.Second},
	}
}

func (s *Service) BindActive(ctx context.Context, orgID string) (context.Context, error) {
	if orgID == "" {
		return ctx, ErrNotConfigured
	}
	st, err := s.repo.GetActive(ctx, orgID)
	if err != nil {
		return ctx, err
	}
	if st == nil {
		return ctx, ErrNotConfigured
	}
	key, err := Decrypt(st.Encrypted)
	if err != nil {
		return ctx, fmt.Errorf("decrypt llm key: %w", err)
	}
	def, ok := Lookup(st.Provider)
	if ok && def.RequiresKey && key == "" {
		return ctx, ErrNotConfigured
	}
	return WithRuntime(ctx, &Runtime{Provider: st.Provider, Model: st.Model, APIKey: key}), nil
}

func (s *Service) Validate(ctx context.Context, provider, model, apiKey string) (bool, string, error) {
	token, err := s.signAgentToken()
	if err != nil {
		return false, "", err
	}
	body, _ := json.Marshal(map[string]string{
		"provider": provider,
		"model":    model,
		"api_key":  apiKey,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.agentURL+"/v1/agent/llm/validate", bytes.NewReader(body))
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := s.http.Do(req)
	if err != nil {
		return false, "", fmt.Errorf("agent unreachable: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Sprintf("agent validate failed (%d): %s", resp.StatusCode, string(raw)), nil
	}
	var parsed struct {
		OK      bool   `json:"ok"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false, "", err
	}
	return parsed.OK, parsed.Message, nil
}

func (s *Service) Save(ctx context.Context, orgID, userID, provider, model, apiKey string, activate bool) (*Credential, error) {
	def, ok := Lookup(provider)
	if !ok {
		return nil, fmt.Errorf("unknown provider")
	}
	provider = def.ID
	if model == "" {
		model = def.DefaultModel
	}

	encrypted := ""
	hint := ""
	if strings.TrimSpace(apiKey) != "" {
		var err error
		encrypted, err = Encrypt(apiKey)
		if err != nil {
			return nil, err
		}
		hint = Hint(apiKey)
	} else if def.RequiresKey {
		existing, err := s.repo.GetByProvider(ctx, orgID, provider)
		if err != nil {
			return nil, err
		}
		if existing == nil || existing.Encrypted == "" {
			return nil, fmt.Errorf("api key is required")
		}
	}

	now := time.Now()
	if activate {
		_ = s.repo.ClearActive(ctx, orgID)
	}
	return s.repo.Upsert(ctx, orgID, userID, provider, model, encrypted, hint, &now, activate)
}

func (s *Service) signAgentToken() (string, error) {
	secret := s.jwtSecret
	if secret == "" {
		secret = "phase-0-insecure-default"
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "backend",
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(2 * time.Minute).Unix(),
	})
	return token.SignedString([]byte(secret))
}
