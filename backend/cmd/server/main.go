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
	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/handlers"
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/middleware"
	"github.com/charkhaniakash/forge-engine/backend/internal/publishing"
	"github.com/charkhaniakash/forge-engine/backend/internal/ratelimit"
	"github.com/charkhaniakash/forge-engine/backend/internal/repair"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
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
	workItemRepo := repository.NewWorkItemRepository(dbConn)
	wsRepo := repository.NewWorkspaceRepository(dbConn)
	execRepo := repository.NewExecutionRepository(dbConn)
	valRepo := validation.NewValidationRepository(dbConn)

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
	var taskHandlers *handlers.TaskHandlers
	var workspaceHandlers *handlers.WorkspaceHandlers
	var executionHandlers *handlers.ExecutionHandlers
	var validationHandlers *handlers.ValidationHandlers
	var repairHandlers *repair.Handlers
	var publishingHandlers *publishing.Handlers

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

			// ── Task handlers (Phase 5) ───────────────────────────────────────
			agentPlanClient := ingestion.NewAgentPlanClient(agentURL, jwtSecret)
			taskHandlers = handlers.NewTaskHandlers(
				workItemRepo,
				ingestionJobRepo,
				agentPlanClient,
				jwtSecret,
				sugar,
			)

			// ── Workspace / execution sandbox (Phase 6) ───────────────────────
			dockerDriver, driverErr := workspace.NewDockerDriver(sugar)
			if driverErr != nil {
				sugar.Warnw("docker_driver_init_failed",
					"error", driverErr,
					"note", "workspace provisioning will be unavailable")
			} else {
				wsCfg := workspace.DefaultConfig()
				wsManager := workspace.NewWorkspaceManager(
					dockerDriver, wsRepo, tokenCache, wsCfg, sugar)

				// Orphan reaper — runs in background until server shuts down.
				reaperCtx, reaperCancel := context.WithCancel(context.Background())
				defer reaperCancel()
				reaper := workspace.NewWorkspaceReaper(wsManager, wsRepo, wsCfg.ReaperIntervalSeconds, sugar)
				go reaper.Start(reaperCtx)
				sugar.Infow("workspace_reaper_started",
					"interval_seconds", wsCfg.ReaperIntervalSeconds)

				workspaceHandlers = handlers.NewWorkspaceHandlers(
					wsManager, wsRepo, workItemRepo,
					githubRepoRepo, githubInstallationRepo, ingestionJobRepo, sugar)

				// ── Execution engine (Phase 7) ────────────────────────────────
				agentExecClient := execution.NewAgentExecClient(agentURL, jwtSecret)
				execOrchestrator := execution.NewExecutionOrchestrator(
					execRepo, wsRepo, wsManager,
					agentExecClient,
					nil, // publisher wired by NewExecutionHandlers
					jwtSecret, sugar,
				)

				// ── Validation (Phase 8) ──────────────────────────────────────
				// Built before executionHandlers so we can wire the trigger below.
				agentParseClient := validation.NewAgentParseClient(agentURL, jwtSecret)
				detector := validation.NewStackDetector(wsManager)
				valOrchestrator := validation.NewValidationOrchestrator(
					valRepo, wsManager, agentParseClient, detector,
					nil, // publisher wired by NewValidationHandlers
					sugar,
				)
				validationHandlers = handlers.NewValidationHandlers(
					valRepo, workItemRepo, execRepo, valOrchestrator, sugar,
				)

				// ── Repair (Phase 9) ──────────────────────────────────────────
				// Built after validation so the repair orchestrator can re-run validation.
				agentRepairClient := repair.NewAgentRepairClient(agentURL, jwtSecret)
				repairPolicy := repair.NewRepairPolicy()
				repairRepo := repair.NewRepairRepository(dbConn)
				repairOrch := repair.NewOrchestrator(
					repairRepo, valRepo, execRepo, workItemRepo, wsManager,
					valOrchestrator, agentRepairClient, repairPolicy,
					jwtSecret, sugar,
				)
				repairHandlers = repair.NewHandlers(repairRepo, repairOrch, sugar)

				// ── Publishing (Phase 10) ─────────────────────────────────────
				publishingRepo := publishing.NewRepository(dbConn)
				agentSummaryClient := publishing.NewAgentSummaryClient()
				githubPRClient := publishing.NewGitHubPRClient(func(repoFullName string) (string, error) {
					// Resolve installation token via the existing token cache.
					// Uses background context since this is called from async goroutines.
					bgCtx := context.Background()
					repo, err := githubRepoRepo.GetByFullName(bgCtx, repoFullName)
					if err != nil {
						return "", fmt.Errorf("repo not found for %s: %w", repoFullName, err)
					}
					install, err := githubInstallationRepo.GetByID(bgCtx, repo.InstallationID)
					if err != nil {
						return "", fmt.Errorf("installation not found: %w", err)
					}
					token, err := tokenCache.GetInstallationToken(bgCtx, install.GitHubInstallationID)
					if err != nil {
						return "", fmt.Errorf("get installation token: %w", err)
					}
					return token, nil
				})
				publishingOrch := publishing.NewOrchestrator(
					publishingRepo, workItemRepo, execRepo, wsManager,
					githubPRClient, agentSummaryClient, jwtSecret, sugar,
				)
				publishingHandlers = publishing.NewHandlers(
					publishingRepo, publishingOrch, workItemRepo, execRepo,
					wsRepo, githubRepoRepo, sugar,
				)

				// Wire automatic validation + repair trigger into the execution orchestrator.
				// When execution finishes, it fires this closure in a goroutine.
				// The closure orchestrates Phase 8 → Phase 9 based on validation results.
				// 
				// Architecture:
				//   Phase 8 (ValidationOrchestrator) produces validation results.
				//   This trigger consumes those results and decides whether Phase 9 begins.
				//   Phase 8 never decides whether Phase 9 runs - only THIS layer does.
				execOrchestrator.SetValidationTrigger(func(ctx context.Context, taskExecutionID, workspaceID, traceID string) {
					log := sugar.With(
						"task_execution_id", taskExecutionID,
						"workspace_id", workspaceID,
						"trace_id", traceID,
					)

					// Work item transitions require work_items.id, not task_executions.id.
					exec, execErr := execRepo.GetExecution(ctx, taskExecutionID)
					if execErr != nil {
						log.Errorw("validation_trigger_exec_load_failed", "error", execErr)
						return
					}
					workItemID := exec.WorkItemID
					log = log.With("work_item_id", workItemID)

					// Phase 8: Validation
					log.Info("phase_8_auto_validation_starting")
					validationRun, err := valOrchestrator.Run(ctx, taskExecutionID, workspaceID, traceID, "post_change")
					if err != nil {
						log.Errorw("phase_8_validation_failed", "error", err)
						_ = workItemRepo.TransitionToFailed(ctx, workItemID, fmt.Sprintf("validation error: %v", err))
						return
					}

					if validationRun.OverallResult == nil {
						log.Errorw("validation_overall_result_is_nil",
							"validation_run_id", validationRun.ID,
						)
						_ = workItemRepo.TransitionToFailed(ctx, workItemID, "validation completed without overall_result")
						return
					}

					overallResult := *validationRun.OverallResult
					log.Infow("phase_8_validation_complete", "overall_result", overallResult)

					// Phase 9 Decision Point
					// This is where the task orchestration layer decides whether repair begins.
					switch overallResult {
					case "passed":
						log.Info("validation_passed_marking_done")
						_ = workItemRepo.TransitionToDone(ctx, workItemID)

					case "failed_repairable":
						// Phase 9: RepairOrchestrator evaluates RepairPolicy and transitions
						// to repairing only when repair is permitted.
						log.Info("validation_failed_repairable_triggering_repair")
						if err := repairOrch.Run(ctx, taskExecutionID, workspaceID, validationRun.ID, traceID); err != nil {
							log.Errorw("phase_9_repair_failed", "error", err)
						} else {
							log.Info("phase_9_repair_complete")
						}

					case "failed_environment":
						log.Warn("validation_failed_environment_marking_done")
						_ = workItemRepo.TransitionToDone(ctx, workItemID)

					case "failed_requires_human":
						log.Warn("validation_failed_requires_human_marking_failed")
						_ = workItemRepo.TransitionToFailed(ctx, workItemID, "validation failed: requires human intervention")

					default:
						log.Warnw("unexpected_overall_result", "result", overallResult)
						_ = workItemRepo.TransitionToFailed(ctx, workItemID, fmt.Sprintf("unexpected validation result: %s", overallResult))
					}
				})

				executionHandlers = handlers.NewExecutionHandlers(
					execRepo, workItemRepo, wsRepo,
					githubRepoRepo, execOrchestrator, wsManager,
					jwtSecret, sugar,
				)

				sugar.Info("workspace execution sandbox, execution engine, and validation pipeline initialised")
			}

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
		app.Get("/v1/repos/:repoID/qa/sessions/:sessionID/stream",
			qaHandlers.StreamUpgrade,
			websocket.New(qaHandlers.StreamWS),
		)
	}

	if taskHandlers != nil {
		// Phase 5 — Task creation & planning
		app.Get("/v1/missions", middleware.RequireAuth(sugar), taskHandlers.ListMissions)
		app.Post("/v1/repos/:repoID/tasks", middleware.RequireAuth(sugar), taskHandlers.CreateTask)
		app.Get("/v1/repos/:repoID/tasks", middleware.RequireAuth(sugar), taskHandlers.ListTasks)
		app.Get("/v1/repos/:repoID/tasks/:taskID", middleware.RequireAuth(sugar), taskHandlers.GetTask)
		app.Get("/v1/repos/:repoID/tasks/:taskID/plans", middleware.RequireAuth(sugar), taskHandlers.ListPlans)
		app.Put("/v1/repos/:repoID/tasks/:taskID/plan", middleware.RequireAuth(sugar), taskHandlers.UpdatePlan)
		app.Post("/v1/repos/:repoID/tasks/:taskID/approve", middleware.RequireAuth(sugar), taskHandlers.ApproveTask)
		app.Post("/v1/repos/:repoID/tasks/:taskID/replan", middleware.RequireAuth(sugar), taskHandlers.Replan)
		app.Post("/v1/repos/:repoID/tasks/:taskID/cancel", middleware.RequireAuth(sugar), taskHandlers.CancelTask)
		// WebSocket — planning progress stream (token auth via ?token= query param)
		app.Get("/v1/repos/:repoID/tasks/:taskID/stream",
			taskHandlers.StreamUpgrade,
			websocket.New(taskHandlers.StreamWS),
		)
	}

	if workspaceHandlers != nil {
		// Phase 6 — Secure execution workspace (user-facing)
		app.Post("/v1/repos/:repoID/tasks/:taskID/workspace",
			middleware.RequireAuth(sugar), workspaceHandlers.ProvisionWorkspace)
		app.Get("/v1/repos/:repoID/tasks/:taskID/workspace",
			middleware.RequireAuth(sugar), workspaceHandlers.GetWorkspace)
		app.Delete("/v1/repos/:repoID/tasks/:taskID/workspace",
			middleware.RequireAuth(sugar), workspaceHandlers.DestroyWorkspace)
		app.Get("/v1/repos/:repoID/tasks/:taskID/workspace/logs",
			middleware.RequireAuth(sugar), workspaceHandlers.GetWorkspaceLogs)

		// Phase 6 — Internal command execution (called by Phase 7 agent routing)
		app.Post("/v1/internal/workspaces/:workspaceID/exec",
			middleware.RequireInternalAuth(jwtSecret, sugar),
			workspaceHandlers.InternalExec)
	}

	if executionHandlers != nil {
		// Phase 7 — Task execution lifecycle
		app.Post("/v1/repos/:repoID/tasks/:taskID/execute",
			middleware.RequireAuth(sugar), executionHandlers.StartExecution)
		app.Get("/v1/repos/:repoID/tasks/:taskID/execution",
			middleware.RequireAuth(sugar), executionHandlers.GetExecution)
		app.Get("/v1/repos/:repoID/tasks/:taskID/execution/events",
			middleware.RequireAuth(sugar), executionHandlers.GetExecutionEvents)
		app.Get("/v1/repos/:repoID/tasks/:taskID/execution/diffs",
			middleware.RequireAuth(sugar), executionHandlers.GetExecutionDiffs)
		app.Post("/v1/repos/:repoID/tasks/:taskID/execution/cancel",
			middleware.RequireAuth(sugar), executionHandlers.CancelExecution)
		// WebSocket — live execution events
		app.Get("/v1/repos/:repoID/tasks/:taskID/execution/stream",
			executionHandlers.StreamUpgrade,
			websocket.New(executionHandlers.StreamWS),
		)
		// Phase 7 — Internal tool dispatch (called by agent via internal JWT)
		app.Post("/v1/internal/workspaces/:workspaceID/tool",
			middleware.RequireInternalAuth(jwtSecret, sugar),
			executionHandlers.ToolDispatch)
	}

	if validationHandlers != nil {
		// Phase 8 — Validation pipeline
		app.Post("/v1/repos/:repoID/tasks/:taskID/validate",
			middleware.RequireAuth(sugar), validationHandlers.StartValidation)
		app.Get("/v1/repos/:repoID/tasks/:taskID/validation",
			middleware.RequireAuth(sugar), validationHandlers.GetValidation)
		app.Get("/v1/repos/:repoID/tasks/:taskID/validation/diagnostics",
			middleware.RequireAuth(sugar), validationHandlers.GetDiagnostics)
		app.Get("/v1/repos/:repoID/tasks/:taskID/validation/stream",
			validationHandlers.StreamUpgrade,
			websocket.New(validationHandlers.StreamWS),
		)
	}

	if repairHandlers != nil {
		// Phase 9 — Autonomous Self-Repair
		app.Get("/v1/repair/sessions/:id",
			middleware.RequireAuth(sugar), repairHandlers.GetSession)
		app.Get("/v1/repair/sessions/by-task/:taskExecutionID",
			middleware.RequireAuth(sugar), repairHandlers.GetSessionByTaskExecution)
		app.Get("/v1/repair/sessions/:id/attempts",
			middleware.RequireAuth(sugar), repairHandlers.ListAttempts)
		app.Get("/v1/repair/sessions/:id/checkpoints",
			middleware.RequireAuth(sugar), repairHandlers.ListCheckpoints)
		// WebSocket — live repair events
		app.Get("/v1/repair/sessions/:id/stream",
			repairHandlers.StreamUpgrade,
			websocket.New(repairHandlers.StreamWS),
		)
	}

	if publishingHandlers != nil {
		// Phase 10 — Git Operations & Pull Request Automation
		// WebSocket route FIRST (more specific path) to avoid collision with task routes.
		app.Get("/v1/publishing/sessions/:sessionID/stream",
			publishingHandlers.StreamUpgrade,
			websocket.New(publishingHandlers.StreamWS),
		)
		app.Post("/v1/repos/:repoID/tasks/:taskID/publish",
			middleware.RequireAuth(sugar), publishingHandlers.StartPublish)
		app.Get("/v1/repos/:repoID/tasks/:taskID/publish",
			middleware.RequireAuth(sugar), publishingHandlers.GetPublishSession)
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
