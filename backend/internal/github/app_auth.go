package github

import (
	"crypto/rsa"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// AppAuth handles GitHub App JWT authentication
type AppAuth struct {
	appID         string
	privateKey     *rsa.PrivateKey
}

// NewAppAuth creates a new GitHub App authenticator
func NewAppAuth() (*AppAuth, error) {
	appID := os.Getenv("GITHUB_APP_ID")
	if appID == "" {
		return nil, fmt.Errorf("GITHUB_APP_ID not set")
	}

	privateKeyPath := os.Getenv("GITHUB_APP_PRIVATE_KEY_PATH")
	if privateKeyPath == "" {
		return nil, fmt.Errorf("GITHUB_APP_PRIVATE_KEY_PATH not set")
	}

	privateKeyBytes, err := os.ReadFile(privateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read private key: %w", err)
	}

	privateKey, err := jwt.ParseRSAPrivateKeyFromPEM(privateKeyBytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	return &AppAuth{
		appID:     appID,
		privateKey: privateKey,
	}, nil
}

// GenerateAppJWT creates a JWT for GitHub App authentication
// The JWT is valid for 10 minutes (GitHub's max is 10)
func (a *AppAuth) GenerateAppJWT() (string, error) {
	now := time.Now()
	exp := now.Add(10 * time.Minute)

	claims := jwt.MapClaims{
		"iat": now.Unix(),
		"exp": exp.Unix(),
		"iss": a.appID,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	return token.SignedString(a.privateKey)
}

// InstallationToken represents a GitHub installation access token response
type InstallationToken struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expires_at"`
}
