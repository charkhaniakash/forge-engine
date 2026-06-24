package auth

import (
    "os"
    "time"

    "github.com/golang-jwt/jwt/v5"
    "github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// GenerateUserToken creates a JWT token for a user
func GenerateUserToken(user *models.User, orgID, role string) (string, error) {
    secret := os.Getenv("JWT_SECRET")
    if secret == "" {
        secret = "phase-0-insecure-default"
    }

    claims := jwt.MapClaims{
        "sub":    user.ID,
        "email":  user.Email,
        "org_id": orgID,
        "role":   role,
        "iat":    time.Now().Unix(),
        "exp":    time.Now().Add(24 * time.Hour).Unix(), // 24h expiry for user tokens
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString([]byte(secret))
}

// VerifyUserToken verifies and decodes a user JWT
func VerifyUserToken(tokenString string) (map[string]interface{}, error) {
    secret := os.Getenv("JWT_SECRET")
    if secret == "" {
        secret = "phase-0-insecure-default"
    }

    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
        return []byte(secret), nil
    })

    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(jwt.MapClaims)
    if !ok || !token.Valid {
        return nil, err
    }

    return claims, nil
}