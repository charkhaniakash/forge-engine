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

    "github.com/charkhaniakash/forge-engine/backend/internal/db"
    "github.com/charkhaniakash/forge-engine/backend/internal/handlers"
    "github.com/charkhaniakash/forge-engine/backend/internal/middleware"
    "github.com/charkhaniakash/forge-engine/backend/internal/ratelimit"
    "github.com/charkhaniakash/forge-engine/backend/internal/repository"
    "github.com/gofiber/fiber/v2/middleware/cors"
)

func main() {
    // Load env
    godotenv.Load(".env.local")

    // Init logger
    logger, _ := zap.NewProduction()
    defer logger.Sync()
    sugar := logger.Sugar()

    // Connect to DB
    databaseURL := os.Getenv("DATABASE_URL")
    if databaseURL == "" {
        log.Fatal("DATABASE_URL not set")
    }

    dbConn, err := db.NewConnection(databaseURL)
    if err != nil {
        log.Fatalf("Database connection failed: %v", err)
    }
    defer dbConn.Close()

    sugar.Info("Database connected")

    // Initialize repositories
    userRepo := repository.NewUserRepository(dbConn)
    orgRepo := repository.NewOrgRepository(dbConn)
    invitationRepo := repository.NewInvitationRepository(dbConn)

    // Initialize handlers
    authHandlers := handlers.NewAuthHandlers(userRepo, orgRepo, sugar)
    orgHandlers := handlers.NewOrgHandlers(orgRepo, invitationRepo, userRepo, sugar)

    // Initialize rate limiter
    limiter := ratelimit.NewLimiter(ratelimit.DefaultConfig())
    _ = limiter // Phase 6: will actually use this

    // Create Fiber app
    app := fiber.New(fiber.Config{
        AppName: "Forge Engine Backend",
    })

    // CORS middleware
    app.Use(cors.New(cors.Config{
        AllowOrigins: "http://localhost:5173",
    }))

    // Middleware: trace ID
    app.Use(traceIDMiddleware())
    // Public endpoints
    app.Get("/health", func(c *fiber.Ctx) error {
        return c.JSON(map[string]string{"status": "ok"})
    })

    app.Get("/readiness", func(c *fiber.Ctx) error {
        return c.JSON(map[string]string{"status": "ready"})
    })

    app.Get("/version", func(c *fiber.Ctx) error {
        return c.JSON(map[string]string{"version": "0.1.0"})
    })

    // Auth endpoints (public)
    app.Post("/v1/auth/signup", authHandlers.Signup)
    app.Post("/v1/auth/login", authHandlers.Login)

    // Protected endpoints
    app.Post("/v1/orgs", middleware.RequireAuth(sugar), orgHandlers.CreateOrg)
    app.Get("/v1/orgs", middleware.RequireAuth(sugar), orgHandlers.ListOrgs)
    app.Get("/v1/orgs/:orgID", middleware.RequireAuth(sugar), orgHandlers.GetOrg)
    app.Get("/v1/orgs/:orgID/members", middleware.RequireAuth(sugar), orgHandlers.ListMembers)
    app.Post("/v1/orgs/:orgID/members/invite", middleware.RequireAuth(sugar), orgHandlers.InviteMember)

    // Internal service endpoint (Phase 0 JWT)
    app.Post("/v1/backend/agent-request", func(c *fiber.Ctx) error {
        traceID := c.Locals("trace_id").(string)
        sugar.Infow("agent_request", "trace_id", traceID)

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

// signAgentToken creates a signed JWT for Agent authentication (Phase 0)
func signAgentToken(traceID string) (string, error) {
    secret := os.Getenv("JWT_SECRET")
    if secret == "" {
        secret = "phase-0-insecure-default"
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "sub":      "backend",
        "trace_id": traceID,
        "iat":      time.Now().Unix(),
        "exp":      time.Now().Add(5 * time.Minute).Unix(),
    })

    return token.SignedString([]byte(secret))
}