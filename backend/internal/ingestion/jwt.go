package ingestion

import (
	"github.com/golang-jwt/jwt/v5"
)

// SignJWT creates a signed HS256 JWT from the given claims map.
// Used by both the ingestion worker and the QA client to sign
// Backend→Agent calls (ADR 0001).
func SignJWT(claims map[string]interface{}, secret string) (string, error) {
	if secret == "" {
		secret = "phase-0-insecure-default"
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims(claims))
	return token.SignedString([]byte(secret))
}
