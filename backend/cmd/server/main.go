package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/websocket/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/db"
	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/handlers"
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/middleware"
	"github.com/charkhaniakash/forge-engine/backend/internal/ratelimit"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

func main() {
	godotenv.Load(".env.local")

	logger, _ := zap.NewProduction()
	defer logger.Sync()
	sugar := logger.Sugar()

	// ── Database ──────────────────────────────────────────────────────────────
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

	// ── Redis ─────────────────────────────────────────────────────────────────
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379/0"
	}
	redisOpts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("Invalid REDIS_URL: %v", err)
	}
	redisClient := redis.NewClient(redisOpts)
	defer redisClient.Close()

	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		sugar.Warnw("redis_ping_failed", "error", err)
	} else {
		sugar.Info("Redis connected")
	}

	// ── Repositories ─────────────────────────────────────────────────────────
	userRepo := repository.NewUserRepository(dbConn)
	orgRepo := repository.NewOrgRepository(dbConn)
	invitationRepo := repository.NewInvitationRepository(dbConn)
	githubInstallationRepo := repository.NewGitHubInstallationRepository(dbConn)
	githubRepoRepo := repository.NewGitHubRepoRepository(dbConn)
	pendingInstallRepo := repository.NewPendingInstallRepository(dbConn)
	webhookDeliveryRepo := repository.NewWebhookDeliveryRepository(dbConn)
	ingestionJobRepo := repository.NewIngestionJobRepository(dbConn)
	qaRepo := repository.NewQARepository(dbConn)

	// ── Auth handlers ─────────────────────────────────────────────────────────
	authHandlers := handlers.NewAuthHandlers(userRepo, orgRepo, sugar)
	orgHandlers := handlers.NewOrgHandlers(orgRepo, invitationRepo, userRepo, sugar)

	// ── GitHub App + ingestion worker ─────────────────────────────────────────
	var appAuth *github.AppAuth
	var githubClient *github.Client
	var tokenCache *github.TokenCache
	var jobWorker *ingestion.JobWorker
	var githubHandlers *handlers.GitHubHandlers
	var ingestionHandlers *handlers.IngestionHandlers
	var qaHandlers *handlers.QAHandlers

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "phase-0-insecure-default"
	}

	if os.Getenv("GITHUB_APP_ID") != "" {
		appAuth, err = github.NewAppAuth()
		if err != nil {
			sugar.Warnw("failed_to_init_github_app_auth", "error", err)
		}

		githubClient, err = github.NewClient()
		if err != nil {
			sugar.Warnw("failed_to_init_github_client", "error", err)
		}

		if appAuth != nil && githubClient != nil {
			tokenCache = github.NewTokenCache(appAuth, githubClient, githubInstallationRepo, sugar)

			githubAppName := os.Getenv("GITHUB_APP_NAME")
			if githubAppName == "" {
				githubAppName = "forge-engine"
			}
			stateSecret := os.Getenv("GITHUB_INSTALL_STATE_SECRET")
			if stateSecret == "" {
				stateSecret = jwtSecret
			}

			// ── Ingestion worker (Phase 3) ────────────────────────────────────
			agentURL := os.Getenv("AGENT_URL")
			if agentURL == "" {
				agentURL = "http://agent:8000"
			}
			cloneBaseDir := os.Getenv("CLONE_BASE_DIR") // defaults to /tmp/forge-clones

			workerConcurrency := 2
			if v := os.Getenv("WORKER_CONCURRENCY"); v != "" {
				if n, err := strconv.Atoi(v); err == nil && n > 0 {
					workerConcurrency = n
				}
			}

			cloner := ingestion.NewCloner(cloneBaseDir, sugar)
			agentClient := ingestion.NewAgentClient(agentURL, jwtSecret)

			jobWorker = ingestion.NewJobWorker(ingestion.WorkerConfig{
				Redis:       redisClient,
				JobRepo:     ingestionJobRepo,
				InstallRepo: githubInstallationRepo,
				RepoRepo:    githubRepoRepo,
				TokenCache:  tokenCache,
				Cloner:      cloner,
				AgentClient: agentClient,
				Logger:      sugar,
				JWTSecret:   jwtSecret,
				Concurrency: workerConcurrency,
			})

			// Start worker pool in background; cancelled on server shutdown.
			workerCtx, workerCancel := context.WithCancel(context.Background())
			defer workerCancel()
			go jobWorker.Start(workerCtx)
			sugar.Infow("ingestion_worker_started", "concurrency", workerConcurrency)

			githubHandlers = handlers.NewGitHubHandlers(
				githubInstallationRepo,
				githubRepoRepo,
				pendingInstallRepo,
				tokenCache,
				githubClient,
				sugar,
				githubAppName,
				stateSecret,
				webhookDeliveryRepo,
				appAuth,
				ingestionJobRepo,
				jobWorker,
			)

			ingestionHandlers = handlers.NewIngestionHandlers(
				ingestionJobRepo,
				githubRepoRepo,
				jobWorker,
				sugar,
			)

			// ── QA handlers (Phase 4) ─────────────────────────────────────────
			agentQAClient := ingestion.NewAgentQAClient(agentURL, jwtSecret)
			qaHandlers = handlers.NewQAHandlers(
				qaRepo,
				ingestionJobRepo,
				githubRepoRepo,
				agentQAClient,
				jwtSecret,
				sugar,
			)

			sugar.Info("GitHub integration and ingestion worker initialised")
		}
	} else {
		sugar.Info("GITHUB_APP_ID not set — GitHub integration and ingestion disabled")
	}

	// ── Rate limiter (stubbed until Phase 6) ─────────────────────────────────
	limiter := ratelimit.NewLimiter(ratelimit.DefaultConfig())
	_ = limiter

	// ── Fiber app ─────────────────────────────────────────────────────────────
	app := fiber.New(fiber.Config{AppName: "Forge Engine Backend"})

	app.Use(cors.New(cors.Config{
		AllowOrigins: os.Getenv("CORS_ORIGINS"),
	}))
	if os.Getenv("CORS_ORIGINS") == "" {
		app.Use(cors.New(cors.Config{AllowOrigins: "http://localhost:5173"}))
	}

	app.Use(traceIDMiddleware())

	// ── Public endpoints ──────────────────────────────────────────────────────
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	app.Get("/readiness", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ready"})
	})
	app.Get("/version", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"version": "0.1.0"})
	})

	// ── Auth ──────────────────────────────────────────────────────────────────
	app.Post("/v1/auth/signup", authHandlers.Signup)
	app.Post("/v1/auth/login", authHandlers.Login)

	// ── Org management ────────────────────────────────────────────────────────
	app.Post("/v1/orgs", middleware.RequireAuth(sugar), orgHandlers.CreateOrg)
	app.Get("/v1/orgs", middleware.RequireAuth(sugar), orgHandlers.ListOrgs)
	app.Get("/v1/orgs/:orgID", middleware.RequireAuth(sugar), orgHandlers.GetOrg)
	app.Get("/v1/orgs/:orgID/members", middleware.RequireAuth(sugar), orgHandlers.ListMembers)
	app.Post("/v1/orgs/:orgID/members/invite", middleware.RequireAuth(sugar), orgHandlers.InviteMember)

	// ── GitHub + ingestion endpoints ──────────────────────────────────────────
	if githubHandlers != nil {
		// Public (GitHub → backend)
		app.Post("/v1/github/webhook", githubHandlers.Webhook)
		app.Get("/v1/github/install/callback", githubHandlers.InstallCallback)

		// Protected (frontend → backend)
		app.Get("/v1/github/install/url", middleware.RequireAuth(sugar), githubHandlers.GetInstallURL)
		app.Post("/v1/github/installations/link", middleware.RequireAuth(sugar), githubHandlers.LinkInstallation)
		app.Get("/v1/github/repos", middleware.RequireAuth(sugar), githubHandlers.ListRepos)
		app.Post("/v1/github/sync", middleware.RequireAuth(sugar), githubHandlers.SyncRepos)
	}

	if ingestionHandlers != nil {
		// Phase 3 — ingestion status and manual trigger
		app.Get("/v1/github/repos/:repoID/index/status", middleware.RequireAuth(sugar), ingestionHandlers.GetIndexStatus)
		app.Post("/v1/github/repos/:repoID/index/trigger", middleware.RequireAuth(sugar), ingestionHandlers.TriggerIndex)
	}

	if qaHandlers != nil {
		// Phase 4 — Q&A sessions
		app.Post("/v1/repos/:repoID/qa/sessions", middleware.RequireAuth(sugar), qaHandlers.CreateSession)
		app.Get("/v1/repos/:repoID/qa/sessions", middleware.RequireAuth(sugar), qaHandlers.ListSessions)
		app.Get("/v1/repos/:repoID/qa/sessions/:sessionID", middleware.RequireAuth(sugar), qaHandlers.GetSession)
		app.Post("/v1/repos/:repoID/qa/sessions/:sessionID/ask", middleware.RequireAuth(sugar), qaHandlers.Ask)
		// WebSocket — upgrade check (with inline JWT auth) runs first, then the WS handler.
		// RequireAuth is NOT used here because browsers cannot send Authorization headers
		// on WebSocket upgrades; the token is validated from the ?token= query parameter.
		app.Get("/v1/repos/:repoID/qa/sessions/:sessionID/stream",
			qaHandlers.StreamUpgrade,
			websocket.New(qaHandlers.StreamWS),
		)
	}

	// ── Internal Backend→Agent endpoint (Phase 0) ────────────────────────────
	app.Post("/v1/backend/agent-request", func(c *fiber.Ctx) error {
		traceID := c.Locals("trace_id").(string)
		token, err := signAgentToken(traceID, jwtSecret)
		if err != nil {
			sugar.Errorw("failed_to_sign_token", "error", err)
			return c.Status(500).JSON(fiber.Map{"error": "token_generation_failed"})
		}
		return c.JSON(fiber.Map{"token": token, "trace_id": traceID})
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

func traceIDMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		traceID := c.Get("X-Trace-ID")
		if traceID == "" {
			traceID = fmt.Sprintf("req-%d-%d", os.Getpid(), time.Now().UnixNano())
		}
		c.Locals("trace_id", traceID)
		c.Set("X-Trace-ID", traceID)
		return c.Next()
	}
}

func signAgentToken(traceID string, secret string) (string, error) {
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
