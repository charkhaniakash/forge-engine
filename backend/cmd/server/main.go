package main

import (
    "fmt"
    "log"
    "os"

    "github.com/gofiber/fiber/v2"
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