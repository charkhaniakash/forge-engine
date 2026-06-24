package github

import (
	"context"
	"fmt"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"go.uber.org/zap"
)

// TokenCache manages GitHub installation token caching and refresh
type TokenCache struct {
	appAuth              *AppAuth
	client               *Client
	installationRepo     *repository.GitHubInstallationRepository
	logger               *zap.SugaredLogger
}

// NewTokenCache creates a new token cache
func NewTokenCache(
	appAuth *AppAuth,
	client *Client,
	installationRepo *repository.GitHubInstallationRepository,
	logger *zap.SugaredLogger,
) *TokenCache {
	return &TokenCache{
		appAuth:          appAuth,
		client:           client,
		installationRepo: installationRepo,
		logger:           logger,
	}
}

// GetInstallationToken gets a valid installation token, refreshing if necessary
func (tc *TokenCache) GetInstallationToken(ctx context.Context, installationID int64) (string, error) {
	// Get installation from DB
	installation, err := tc.installationRepo.GetByGitHubInstallationID(ctx, installationID)
	if err != nil {
		return "", fmt.Errorf("failed to get installation: %w", err)
	}

	// Check if we have a cached token that's still valid
	if installation.AccessToken != "" && installation.TokenExpiresAt != nil {
		// Refresh if token expires in less than 5 minutes
		if time.Until(*installation.TokenExpiresAt) > 5*time.Minute {
			return installation.AccessToken, nil
		}
		tc.logger.Infow("token_expiring_soon", "installation_id", installationID, "expires_at", installation.TokenExpiresAt)
	}

	// Generate new app JWT
	appJWT, err := tc.appAuth.GenerateAppJWT()
	if err != nil {
		return "", fmt.Errorf("failed to generate app JWT: %w", err)
	}

	// Get new installation token from GitHub
	tokenResp, err := tc.client.GetInstallationToken(appJWT, installation.GitHubInstallationID)
	if err != nil {
		return "", fmt.Errorf("failed to get installation token: %w", err)
	}

	// Parse expiry time
	expiresAt, err := time.Parse(time.RFC3339, tokenResp.ExpiresAt)
	if err != nil {
		return "", fmt.Errorf("failed to parse token expiry: %w", err)
	}

	// Cache the new token
	err = tc.installationRepo.UpdateAccessToken(ctx, installation.ID, tokenResp.Token, expiresAt)
	if err != nil {
		tc.logger.Warnw("failed_to_cache_token", "error", err, "installation_id", installationID)
		// Return token anyway even if caching fails
		return tokenResp.Token, nil
	}

	tc.logger.Infow("token_refreshed", "installation_id", installationID, "expires_at", expiresAt)

	return tokenResp.Token, nil
}

// InvalidateToken invalidates a cached token (e.g., on uninstall)
func (tc *TokenCache) InvalidateToken(ctx context.Context, installationID int64) error {
	installation, err := tc.installationRepo.GetByGitHubInstallationID(ctx, installationID)
	if err != nil {
		return fmt.Errorf("failed to get installation: %w", err)
	}

	// Clear the cached token by setting it to empty and expiry to past
	past := time.Now().Add(-1 * time.Hour)
	return tc.installationRepo.UpdateAccessToken(ctx, installation.ID, "", past)
}
