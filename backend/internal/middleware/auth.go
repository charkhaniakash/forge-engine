package middleware

import (
    "strings"

    "github.com/golang-jwt/jwt/v5"
    "github.com/gofiber/fiber/v2"
    "go.uber.org/zap"

    "github.com/charkhaniakash/forge-engine/backend/internal/auth"
)

// RequireAuth middleware checks for a valid user JWT token.
func RequireAuth(logger *zap.SugaredLogger) fiber.Handler {
    return func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)

        authHeader := c.Get("Authorization")
        if authHeader == "" {
            logger.Warnw("missing_auth_header", "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "missing authorization header"})
        }

        parts := strings.Split(authHeader, " ")
        if len(parts) != 2 || parts[0] != "Bearer" {
            logger.Warnw("invalid_auth_header", "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "invalid authorization header"})
        }

        token := parts[1]
        claims, err := auth.VerifyUserToken(token)
        if err != nil {
            logger.Warnw("token_verification_failed", "error", err, "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "invalid token"})
        }

        userID, ok := claims["sub"].(string)
        if !ok {
            logger.Warnw("invalid_token_claims", "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "invalid token claims"})
        }

        orgID, _ := claims["org_id"].(string)
        role, _ := claims["role"].(string)

        c.Locals("user_id", userID)
        c.Locals("org_id", orgID)
        c.Locals("role", role)

        logger.Debugw("auth_success", "user_id", userID, "org_id", orgID, "trace_id", traceID)

        return c.Next()
    }
}

// RequireInternalAuth validates a Backend-to-Backend JWT signed with the
// shared jwtSecret. Used to protect the internal execution endpoint
// (/v1/internal/workspaces/:id/exec) so it cannot be called from the internet
// or by the user-facing frontend.
//
// In Phase 7, the Agent will obtain a short-lived token from the backend and
// use it to call this endpoint. The token must have sub="backend".
func RequireInternalAuth(jwtSecret string, logger *zap.SugaredLogger) fiber.Handler {
    return func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)

        authHeader := c.Get("Authorization")
        if authHeader == "" {
            return c.Status(401).JSON(fiber.Map{"error": "missing authorization header"})
        }

        parts := strings.Split(authHeader, " ")
        if len(parts) != 2 || parts[0] != "Bearer" {
            return c.Status(401).JSON(fiber.Map{"error": "invalid authorization header"})
        }

        tokenStr := parts[1]
        if jwtSecret == "" {
            jwtSecret = "phase-0-insecure-default"
        }

        token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
            return []byte(jwtSecret), nil
        })
        if err != nil || !token.Valid {
            logger.Warnw("internal_auth_failed", "error", err, "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "invalid internal token"})
        }

        claims, ok := token.Claims.(jwt.MapClaims)
        if !ok {
            return c.Status(401).JSON(fiber.Map{"error": "invalid token claims"})
        }

        sub, _ := claims["sub"].(string)
        if sub != "backend" {
            logger.Warnw("internal_auth_wrong_subject",
                "sub", sub, "trace_id", traceID)
            return c.Status(403).JSON(fiber.Map{"error": "forbidden"})
        }

        return c.Next()
    }
}

// RequireRole middleware checks if user has required role in current org.
func RequireRole(requiredRole string, logger *zap.SugaredLogger) fiber.Handler {
    return func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)
        role := c.Locals("role").(string)

        if role != "owner" && role != requiredRole {
            logger.Warnw("role_check_failed", "required", requiredRole, "actual", role, "trace_id", traceID)
            return c.Status(403).JSON(fiber.Map{"error": "insufficient permissions"})
        }

        return c.Next()
    }
}