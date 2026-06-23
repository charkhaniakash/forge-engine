package main

import (
    "fmt"
    "log"
    "os"
    "time"

    "github.com/gofiber/fiber/v2"
    "github.com/golang-jwt/jwt/v5"
    "github.com/joho/godotenv"
    "go.uber.org/zap"
)

func main() {
    // Load env
    godotenv.Load(".env.local")

    // Init logger
    logger, _ := zap.NewProduction()
    defer logger.Sync()
    sugar := logger.Sugar()

    // Create Fiber app
    app := fiber.New(fiber.Config{
        AppName: "Forge Engine Backend",
    })

    // Middleware: trace ID
    app.Use(traceIDMiddleware())

    // Health check
    app.Get("/health", func(c *fiber.Ctx) error {
        return c.JSON(map[string]string{
            "status": "ok",
        })
    })

    // Readiness check
    app.Get("/readiness", func(c *fiber.Ctx) error {
        // TODO: check DB, Redis, Agent service connectivity
        return c.JSON(map[string]string{
            "status": "ready",
        })
    })

    // Version
    app.Get("/version", func(c *fiber.Ctx) error {
        return c.JSON(map[string]string{
            "version": "0.1.0",
        })
    })

    // Internal: request Agent with JWT
    app.Post("/v1/backend/agent-request", func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)
        sugar.Infow("agent_request", "trace_id", traceID)

        // Sign a token for Agent
        token, err := signAgentToken(traceID)
        if err != nil {
            sugar.Errorw("failed_to_sign_token", "error", err)
            return c.Status(500).JSON(map[string]string{"error": "token_generation_failed"})
        }

        return c.JSON(map[string]string{
            "token":    token,
            "trace_id": traceID,
        })
    })

    port := os.Getenv("BACKEND_PORT")
    if port == "" {
        port = "8080"
    }

    sugar.Infof("Backend listening on :%s", port)
    if err := app.Listen(":" + port); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }
}

// traceIDMiddleware adds a trace ID to every request
func traceIDMiddleware() fiber.Handler {
    return func(c *fiber.Ctx) error {
        traceID := c.Get("X-Trace-ID")
        if traceID == "" {
            traceID = fmt.Sprintf("req-%d", os.Getpid())
        }
        c.Locals("trace_id", traceID)
        c.Set("X-Trace-ID", traceID)
        return c.Next()
    }
}

// signAgentToken creates a signed JWT for Agent authentication
func signAgentToken(traceID string) (string, error) {
    secret := os.Getenv("JWT_SECRET")
    if secret == "" {
        secret = "phase-0-insecure-default" // Only for local dev!
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "sub":      "backend",
        "trace_id": traceID,
        "iat":      time.Now().Unix(),
        "exp":      time.Now().Add(5 * time.Minute).Unix(),
    })

    return token.SignedString([]byte(secret))
}