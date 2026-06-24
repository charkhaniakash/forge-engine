package middleware

import (
    "strings"

    "github.com/gofiber/fiber/v2"
    "go.uber.org/zap"

    "github.com/charkhaniakash/forge-engine/backend/internal/auth"
)

// RequireAuth middleware checks for a valid JWT token
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

        // Extract claims
        userID, ok := claims["sub"].(string)
        if !ok {
            logger.Warnw("invalid_token_claims", "trace_id", traceID)
            return c.Status(401).JSON(fiber.Map{"error": "invalid token claims"})
        }

        orgID, _ := claims["org_id"].(string)
        role, _ := claims["role"].(string)

        // Store in locals for handlers
        c.Locals("user_id", userID)
        c.Locals("org_id", orgID)
        c.Locals("role", role)

        logger.Debugw("auth_success", "user_id", userID, "org_id", orgID, "trace_id", traceID)

        return c.Next()
    }
}

// RequireRole middleware checks if user has required role in current org
func RequireRole(requiredRole string, logger *zap.SugaredLogger) fiber.Handler {
    return func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)
        role := c.Locals("role").(string)

        // Check role
        if role != "owner" && role != requiredRole {
            logger.Warnw("role_check_failed", "required", requiredRole, "actual", role, "trace_id", traceID)
            return c.Status(403).JSON(fiber.Map{"error": "insufficient permissions"})
        }

        return c.Next()
    }
}