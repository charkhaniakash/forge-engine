package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/websocket/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/browserworkspace"
	"github.com/charkhaniakash/forge-engine/backend/internal/db"
	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/handlers"
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/llmcreds"
	"github.com/charkhaniakash/forge-engine/backend/internal/middleware"
	"github.com/charkhaniakash/forge-engine/backend/internal/pipeline"
	"github.com/charkhaniakash/forge-engine/backend/internal/publishing"
	"github.com/charkhaniakash/forge-engine/backend/internal/ratelimit"
	"github.com/charkhaniakash/forge-engine/backend/internal/repair"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/streaming"
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
	missionMsgRepo := repository.NewMissionMessageRepository(dbConn)
	wsRepo := repository.NewWorkspaceRepository(dbConn)
	execRepo := repository.NewExecutionRepository(dbConn)
	valRepo := validation.NewValidationRepository(dbConn)

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "phase-0-insecure-default"
	}

	agentURL := os.Getenv("AGENT_URL")
	if agentURL == "" {
		agentURL = "http://agent:8000"
	}

	llmCredRepo := llmcreds.NewRepository(dbConn)
	llmService := llmcreds.NewService(llmCredRepo, agentURL, jwtSecret)
	llmHandlers := llmcreds.NewHandlers(llmService, llmCredRepo, sugar)

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
	var bwHandlers *browserworkspace.Handlers
	var bwGateway *browserworkspace.Gateway

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
			qaHandlers.SetLLM(llmService)

			// ── Task handlers (Phase 5) ───────────────────────────────────────
			agentPlanClient := ingestion.NewAgentPlanClient(agentURL, jwtSecret)
			taskHandlers = handlers.NewTaskHandlers(
				workItemRepo,
				ingestionJobRepo,
				missionMsgRepo,
				agentPlanClient,
				jwtSecret,
				sugar,
			)
			taskHandlers.SetLLM(llmService)

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
					nil, // publisher wired below
					sugar,
				)
				// Don't create validation handlers yet - we need to wire the event bridge first

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
				repairOrch.SetLLM(llmService)
				repairHandlers = repair.NewHandlers(repairRepo, repairOrch, sugar)

				// ── Pipeline pause/cancel infrastructure ──────────────────────
				contextRegistry := pipeline.NewContextRegistry()
				execOrchestrator.SetContextRegistry(contextRegistry)
				execOrchestrator.SetLLM(llmService)
				pauseChecker := pipeline.NewPauseChecker(execRepo)

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
				publishingOrch.SetLLM(llmService)
				publishingHandlers = publishing.NewHandlers(
					publishingRepo, publishingOrch, workItemRepo, execRepo,
					wsRepo, githubRepoRepo, sugar,
				)

				// ── Phase 10B: Browser Workspace Services ─────────────────────
				bwGateway = browserworkspace.NewGateway(wsRepo, workItemRepo, sugar)
				bwFsService := browserworkspace.NewFilesystemService(wsManager, bwGateway, sugar)
				bwTermService := browserworkspace.NewTerminalService(wsManager, bwGateway, sugar)
				bwGateway.SetTerminalService(bwTermService)
				bwGateway.SetFilesystemService(bwFsService)
				bwGateway.SetExecutionRepository(execRepo)
				bwGateway.SetContextRegistry(contextRegistry)
				bwHandlers = browserworkspace.NewHandlers(bwGateway, bwFsService, bwTermService, wsRepo, workItemRepo, execRepo, wsManager, contextRegistry, sugar)
				// Wire preview service
				bwPreviewService := browserworkspace.NewPreviewService(wsManager, wsRepo, bwGateway, sugar)
				bwHandlers.SetPreviewService(bwPreviewService)
				_ = bwFsService  // used by handlers
				_ = bwTermService // used by handlers

				// Wire the event bridge: forward execution/validation/repair events
				// into the unified browser workspace gateway so browser clients see
				// AI activity in real-time.
				eventBridge := browserworkspace.NewEventBridge(bwGateway, sugar)
				eventBridge.SetFilesystemService(bwFsService)

				// Phase 11: Wire the durable Event Store into the event bridge.
				// Events are persisted to stream_events before being broadcast to
				// connected browsers. The ReplayBuffer serves as the hot cache.
				streamEventStore := streaming.NewEventStore(dbConn, sugar)
				streamReplayBuf := streaming.NewReplayBuffer(streaming.DefaultBufferCapacity)
				streamReplayEngine := streaming.NewReplayEngine(streamReplayBuf, streamEventStore, sugar)
				streamEventStore.SetOnPersist(func(workspaceID string, env streaming.Envelope) {
					// 1. Update in-memory replay buffer
					streamReplayBuf.Append(workspaceID, env)
					// 2. Broadcast to connected WebSocket sessions (existing gateway fan-out)
					bwGateway.Publish(workspaceID, env.Channel, env.Event, env.Payload)
				})
				eventBridge.SetEventStore(streamEventStore)
				bwGateway.SetReplayEngine(streamReplayEngine)

				// Phase 11C: Ack manager for delivery tracking and gap detection.
				streamAckManager := streaming.NewAckManager(sugar, nil) // metrics wired later
				bwGateway.SetAckManager(streamAckManager)

				// Start the TTL cleanup worker (deletes stream events older than 14 days)
				go streaming.StartCleanupWorker(context.Background(), streamEventStore, streaming.DefaultRetention, sugar)

				_ = eventBridge // used below when wiring execution publisher

				// Wire automatic validation + repair trigger into the execution orchestrator.
				// When execution finishes, it fires this closure in a goroutine.
				// The closure orchestrates Phase 8 → Phase 9 based on validation results.
				// 
				// Architecture:
				//   Phase 8 (ValidationOrchestrator) produces validation results.
				//   This trigger consumes those results and decides whether Phase 9 begins.
				//   Phase 8 never decides whether Phase 9 runs - only THIS layer does.
				execOrchestrator.SetValidationTrigger(func(ctx context.Context, taskExecutionID, workspaceID, traceID string) {
						// Phase 10B: Unregister execution→workspace mapping after
						// execution completes (registered by OnStartHook at exec start).
						if eventBridge != nil {
							defer eventBridge.UnregisterExecution(taskExecutionID)
						}

					// The taskExecutionID IS the execution ID for pause/cancel checks.
					execID := taskExecutionID

					// checkPauseCancel checks pause/cancel at a phase transition.
					// Returns true if cancelled (caller should abort).
					checkPauseCancel := func(phase string) bool {
						if pauseChecker.IsCancelled(ctx, execID) {
							if bwGateway != nil {
								bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{"status": "stopped", "message": phase + " cancelled"})
							}
							return true
						}
						if pauseChecker.IsPaused(ctx, execID) {
							if bwGateway != nil {
								bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{"status": "paused"})
							}
							if cancelled := pauseChecker.WaitForResume(ctx, execID); cancelled {
								if bwGateway != nil {
									bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{"status": "stopped"})
								}
								return true
							}
							// Resumed — publish running again
							if bwGateway != nil {
								bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{"status": "running", "message": phase})
							}
						}
						return false
					}

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

					// Publish gate (opt-in). Default false preserves the advisory,
					// non-blocking policy below; PUBLISH_REQUIRE_GREEN=1 blocks
					// publishing whenever the final tree is not green.
					requireGreen := publishRequiresGreen()

					// ── False-success guard: did the execution change anything? ───
					// The workspace working tree is the authoritative source of truth.
					// If the agent produced zero real changes (declared a step
					// "already satisfied" without writing, or wrote identical
					// content), there is nothing to validate, repair, or publish.
					// Marking such a run "done" was a false-success bug: the UI showed
					// a green success and auto-publish then failed with "no code
					// changes to publish". Instead we end in the honest "no_changes"
					// terminal state so the user knows the request produced no diff and
					// can refine it. This check runs BEFORE validation so build
					// artifacts (node_modules, dist/) can never mask an empty diff.
					// On a check error we do NOT block (advisory principle) — fall
					// through to the normal flow.
					if changed, chErr := wsManager.HasChanges(ctx, workspaceID); chErr != nil {
						log.Warnw("no_change_check_failed_proceeding", "error", chErr)
					} else if !changed {
						log.Infow("execution_made_no_changes_marking_no_changes")
						if bwGateway != nil {
							bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
								"phase": "done", "status": "no_changes",
							})
							bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{
								"status":  "no_changes",
								"message": "No code changes were made for this request",
							})
						}
						reason := "No code changes were made — the assumed change was already present in the code, so no diff was produced. Refine the request or point to the specific file or symptom to change."
						if ncErr := workItemRepo.TransitionToNoChanges(ctx, workItemID, reason); ncErr != nil {
							log.Errorw("transition_no_changes_failed", "error", ncErr)
						}
						return
					}

					// Phase 8: Validation
					//
					// NON-BLOCKING POLICY (Devin-style): validation is ADVISORY.
					// Lint / test / build results never block the pipeline — the work
					// item always ends in a publishable ("done") state, and the detailed
					// verdict + logs live on the validation run for the UI to surface.
					// Repairable issues still get one automatic repair pass, but if repair
					// doesn't fully resolve them (or validation couldn't even run) we
					// proceed anyway. ForceToDone recovers the item even if an
					// intermediate step marked it "failed".

					// ── Pause/Cancel check BEFORE Phase 8 (Validation) ────────
					if checkPauseCancel("Validating") {
						log.Info("validation_trigger_cancelled_before_phase_8")
						return
					}

					// Phase 10B: Notify browser workspace that validation is starting
					if bwGateway != nil {
						bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_started", map[string]interface{}{
							"phase": "validation", "status": "running",
						})
						bwGateway.Publish(workspaceID, browserworkspace.ChAIActivity, "validation_started", map[string]interface{}{
							"message": "Running validation (build, test, lint)...",
						})
						bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{
							"status": "running", "message": "Validating",
						})
					}

					log.Info("phase_8_auto_validation_starting")
					validationRun, err := valOrchestrator.Run(ctx, taskExecutionID, workspaceID, traceID, "post_change", execID, pauseChecker)
					if err != nil {
						// Validation infrastructure error — couldn't run at all.
						// Per the non-blocking policy, proceed rather than fail.
						log.Warnw("phase_8_validation_could_not_run_proceeding", "error", err)
						if requireGreen {
							// Gate enabled: validation could not run → not green → do
							// not publish; leave the item failed.
							log.Warnw("publish_blocked_validation_could_not_run")
							_ = workItemRepo.TransitionToFailed(ctx, workItemID, "publish gate: validation could not run")
						} else if !checkPauseCancel("ForceToDone") {
							_ = workItemRepo.ForceToDone(ctx, workItemID)
						}
						return
					}

					overallResult := "unknown"
					if validationRun.OverallResult != nil {
						overallResult = *validationRun.OverallResult
					}
					log.Infow("phase_8_validation_complete", "overall_result", overallResult)

					// Track whether the final tree is green. Starts true only when
					// validation itself passed; a successful repair (repErr == nil,
					// i.e. repair reached the "passed" outcome) flips it true below.
					treeGreen := overallResult == "passed"

					// Phase 10B: Notify browser workspace of validation completion
					if bwGateway != nil {
						bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
							"phase": "validation", "status": "completed", "overall": overallResult,
						})
						bwGateway.Publish(workspaceID, browserworkspace.ChDiagnostics, "run_completed", map[string]interface{}{
							"overall": overallResult, "run_id": validationRun.ID,
						})
					}

					// Auto-repair repairable issues (best-effort). The RepairOrchestrator
					// evaluates RepairPolicy and may mark the item failed internally on
					// escalation / budget exhaustion — that's fine, ForceToDone below
					// recovers it. We proceed regardless of the repair outcome.
					if overallResult == "failed_repairable" {
						// ── Pause/Cancel check BEFORE Phase 9 (Repair) ────────
						if checkPauseCancel("Repairing") {
							log.Info("validation_trigger_cancelled_before_phase_9")
							return
						}

						log.Info("validation_failed_repairable_attempting_repair")

						// Phase 10B: Notify browser workspace that repair is starting
						if bwGateway != nil {
							bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_started", map[string]interface{}{
								"phase": "repair", "status": "running",
							})
							bwGateway.Publish(workspaceID, browserworkspace.ChAIActivity, "repair_started", map[string]interface{}{
								"message": "Auto-repair starting...",
							})
							bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{
								"status": "running", "message": "Repairing",
							})
						}

						if repErr := repairOrch.Run(ctx, taskExecutionID, workspaceID, validationRun.ID, traceID, execID, pauseChecker); repErr != nil {
							log.Warnw("repair_pass_incomplete_proceeding_anyway", "error", repErr)
							if bwGateway != nil {
								bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
									"phase": "repair", "status": "failed",
								})
							}
						} else {
							log.Info("phase_9_repair_complete")
							// repairOrch.Run returns nil only when the repair reached the
							// "passed" outcome, so the post-repair tree is green.
							treeGreen = true
							if bwGateway != nil {
								bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
									"phase": "repair", "status": "success",
								})
							}
						}
					}

					// ── Pause/Cancel check BEFORE ForceToDone (Publishing) ────
					if checkPauseCancel("ForceToDone") {
						log.Info("validation_trigger_cancelled_before_force_to_done")
						return
					}

					// Publish gate (opt-in via PUBLISH_REQUIRE_GREEN). When enabled, a
					// tree that did not end green is NOT marked done — so downstream
					// publishing never fires and the item stays in its failed state.
					if requireGreen && !treeGreen {
						log.Warnw("publish_blocked_validation_not_green", "overall_result", overallResult)
						if bwGateway != nil {
							bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
								"phase": "publish", "status": "blocked", "reason": "validation not green",
							})
						}
						if failErr := workItemRepo.TransitionToFailed(ctx, workItemID, "publish gate: validation not green"); failErr != nil {
							log.Warnw("publish_gate_transition_failed", "error", failErr)
						}
						return
					}

					// Auto-repair ran (or validation already passed). Only mark done
					// and auto-publish when the tree is green. Incomplete repair used
					// to ForceToDone + open a PR with the remaining build error.
					if !treeGreen {
						log.Warnw("auto_publish_skipped_not_green", "overall_result", overallResult)
						if bwGateway != nil {
							bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
								"phase": "publish", "status": "blocked", "reason": "validation still failing",
							})
							bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{
								"status": "failed", "message": "Validation still failing after repair",
							})
						}
						if failErr := workItemRepo.TransitionToFailed(ctx, workItemID, "validation still failing; auto-publish skipped"); failErr != nil {
							log.Warnw("failed_after_ungreen_validation", "error", failErr)
						}
						return
					}

					log.Infow("validation_green_marking_done", "overall_result", overallResult)
					if doneErr := workItemRepo.ForceToDone(ctx, workItemID); doneErr != nil {
						log.Errorw("force_to_done_failed", "error", doneErr)
					}

					// Auto-trigger publishing for auto-run / follow-up tasks.
					// Without this, a follow-up task's changes are stuck in the workspace
					// forever because there is no frontend to call POST /publish. The
					// publishing orchestrator creates a branch, commits, pushes, and
					// creates a PR — all asynchronously. If publishing fails (no changes,
					// workspace gone, etc.) we log and continue; a human can retry via
					// the frontend's publish button.
					go func() {
						item, itemErr := workItemRepo.GetByIDInternal(context.Background(), workItemID)
						if itemErr != nil {
							log.Warnw("auto_publish_work_item_lookup_failed", "error", itemErr)
							return
						}

						ghRepo, ghErr := githubRepoRepo.GetByID(context.Background(), item.RepoID)
						if ghErr != nil {
							log.Warnw("auto_publish_repo_lookup_failed", "error", ghErr)
							return
						}

						ws, wsErr := wsRepo.GetByWorkItemID(context.Background(), workItemID)
						if wsErr != nil || ws == nil {
							log.Warnw("auto_publish_workspace_lookup_failed", "error", wsErr)
							return
						}

						// Prefer the freshest commit SHA available.
						// ghRepo.LastCommitSHA is updated immediately on push webhooks (BUG-1 fix),
						// so it tracks the true remote HEAD. ws.CommitSHA was set at provisioning
						// time and may point to an older commit if PRs have been merged since.
						baseCommitSHA := ws.CommitSHA
						if ghRepo.LastCommitSHA != nil && *ghRepo.LastCommitSHA != "" {
							baseCommitSHA = *ghRepo.LastCommitSHA
						}

						publishReq := publishing.PublishRequest{
							WorkItemID:      workItemID,
							TaskExecutionID: taskExecutionID,
							WorkspaceID:     workspaceID,
							RepoFullName:    ghRepo.RepoFullName,
							DefaultBranch:   ghRepo.DefaultBranch,
							BaseCommitSHA:   baseCommitSHA,
							DraftMode:       false,
							UserID:          "",
							TraceID:         traceID,
						}

						if err := publishingOrch.Run(context.Background(), publishReq); err != nil {
							log.Warnw("auto_publish_failed", "error", err)
						}
					}()

					// Phase 10B: Notify browser workspace that the task is done
					if bwGateway != nil {
						bwGateway.Publish(workspaceID, browserworkspace.ChTimeline, "phase_completed", map[string]interface{}{
							"phase": "done", "status": "success",
						})
						bwGateway.Publish(workspaceID, browserworkspace.ChCollaboration, "state_changed", map[string]interface{}{
							"status": "completed",
						})
					}
				})

				executionHandlers = handlers.NewExecutionHandlers(
					execRepo, workItemRepo, wsRepo,
					githubRepoRepo, execOrchestrator, wsManager,
					jwtSecret, sugar,
				)

				// Server-side auto-run ("Plan off"): when a task's plan is ready and
				// it's flagged auto_run, run approve → provision → execute without a
				// human review gate — fully backend-driven, no client required.
				autoRunner := handlers.NewAutoRunner(
					workItemRepo, wsRepo, wsManager, githubRepoRepo,
					githubInstallationRepo, ingestionJobRepo, execRepo, execOrchestrator, sugar,
				)
				autoRunner.SetPublishRepo(publishingRepo)
				taskHandlers.SetAutoRunHook(autoRunner.Run)
				taskHandlers.SetWorkingTree(wsRepo, wsManager, publishingRepo)
				workspaceHandlers.SetPublishRepo(publishingRepo)

				// Phase 11: Forward planning events to EventStore for durable persistence.
				// When a workspace exists for the task (follow-up scenarios), events
				// are persisted to stream_events for replay survivability.
				taskHandlers.SetPlanningEventHook(func(taskID string, eventJSON []byte) {
					// Resolve workspace for this task (best-effort — may not exist for initial planning)
					ws, err := wsRepo.GetByWorkItemID(context.Background(), taskID)
					if err != nil || ws == nil {
						return // No workspace yet — skip durable persistence, planEventLog handles it
					}
					var parsed map[string]interface{}
					if json.Unmarshal(eventJSON, &parsed) != nil {
						return
					}
					evType, _ := parsed["event"].(string)
					if evType == "" {
						evType = "thinking"
					}
					// Persist through EventStore (planning channel, planning phase)
					_, _ = streamEventStore.Append(
						context.Background(), ws.ID, "planning", evType, parsed, "planning", nil,
					)
				})

				// Phase 10B: Wire all orchestrator publishers to forward events
				// into the unified browser workspace gateway for real-time AI activity,
				// timeline, and diagnostics feeds.

				// ── Execution ──
				if bwGateway != nil {
					originalPub := execOrchestrator.GetPublisher()
					wrappedPub := eventBridge.WrapExecutionPublisher(originalPub)
					execOrchestrator.SetPublisher(wrappedPub)
					execOrchestrator.SetOnStartHook(func(execID, workspaceID string) {
						eventBridge.RegisterExecution(execID, workspaceID)
						// Planning completed before execution started; emit the
						// planning phase marker so the timeline shows the full lifecycle.
						eventBridge.EmitPlanningMarker(workspaceID)
					})

					// ── Validation ──
					// Wire the event bridge BEFORE creating handlers so handlers don't override
					origValPub := valOrchestrator.GetPublisher()
					valOrchestrator.SetPublisher(eventBridge.WrapValidationPublisher(origValPub))
					valOrchestrator.SetOnStartHook(func(runID, wsID string) {
						eventBridge.RegisterValidation(runID, wsID)
					})
					// Now create validation handlers with the already-wrapped publisher
					validationHandlers = handlers.NewValidationHandlers(
						valRepo, workItemRepo, execRepo, valOrchestrator, sugar,
					)

					// ── Repair ──
					origRepairPub := repairOrch.GetPublisher()
					repairOrch.SetPublisher(eventBridge.WrapRepairPublisher(origRepairPub))
					repairOrch.SetOnStartHook(func(sessionID, wsID string) {
						eventBridge.RegisterRepair(sessionID, wsID)
					})

					// ── Publishing ──
					origPubPub := publishingOrch.GetPublisher()
					publishingOrch.SetPublisher(eventBridge.WrapPublishingPublisher(origPubPub))
					publishingOrch.SetOnStartHook(func(sessionID, wsID string) {
						eventBridge.RegisterPublishing(sessionID, wsID)
					})
				}

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
	// Immutable makes c.Params/c.Query/c.Body return copies instead of strings
	// backed by the recycled fasthttp request buffer. Required because handlers
	// like StartPublish capture route params in goroutines that outlive the
	// request — without this the buffer is reused by the next request and the
	// captured value gets corrupted (e.g. a work_item_id turning into
	// "51892ed/stream42a2-...").
	app := fiber.New(fiber.Config{
		AppName:   "Forge Engine Backend",
		Immutable: true,
	})

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

	// ── LLM credentials (BYOK) ────────────────────────────────────────────────
	app.Get("/v1/llm/providers", middleware.RequireAuth(sugar), llmHandlers.ListProviders)
	app.Get("/v1/llm/credentials", middleware.RequireAuth(sugar), llmHandlers.GetConfig)
	app.Post("/v1/llm/credentials", middleware.RequireAuth(sugar), llmHandlers.ValidateAndSave)
	app.Post("/v1/llm/credentials/:provider/activate", middleware.RequireAuth(sugar), llmHandlers.Activate)
	app.Delete("/v1/llm/credentials/:provider", middleware.RequireAuth(sugar), llmHandlers.Delete)

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
		app.Post("/v1/repos/:repoID/tasks/:taskID/refine", middleware.RequireAuth(sugar), taskHandlers.RefinePlan)
		app.Post("/v1/repos/:repoID/tasks/:taskID/follow-up", middleware.RequireAuth(sugar), taskHandlers.FollowUp)
		app.Get("/v1/repos/:repoID/tasks/:taskID/messages", middleware.RequireAuth(sugar), taskHandlers.ListMessages)
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
		app.Get("/v1/repos/:repoID/tasks/:taskID/executions",
			middleware.RequireAuth(sugar), executionHandlers.ListExecutions)
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


	// Phase 10B — Browser Workspace
	if bwHandlers != nil {
		// REST
		app.Get("/v1/workspace/:workspaceID/files", middleware.RequireAuth(sugar), bwHandlers.GetFileTree)
		app.Get("/v1/workspace/:workspaceID/files/*", middleware.RequireAuth(sugar), bwHandlers.GetFileContent)
		app.Put("/v1/workspace/:workspaceID/files/*", middleware.RequireAuth(sugar), bwHandlers.WriteFileContent)
		app.Post("/v1/workspace/:workspaceID/terminal", middleware.RequireAuth(sugar), bwHandlers.CreateTerminal)
		app.Delete("/v1/workspace/:workspaceID/terminal/:terminalID", middleware.RequireAuth(sugar), bwHandlers.CloseTerminal)
		app.Get("/v1/workspace/:workspaceID/git/status", middleware.RequireAuth(sugar), bwHandlers.GetGitStatus)
		app.Get("/v1/workspace/:workspaceID/git/diff", middleware.RequireAuth(sugar), bwHandlers.GetGitDiff)
		app.Get("/v1/workspace/:workspaceID/health", middleware.RequireAuth(sugar), bwHandlers.GetHealth)
		app.Get("/v1/workspace/:workspaceID/progress", middleware.RequireAuth(sugar), bwHandlers.GetProgress)
		app.Post("/v1/workspace/:workspaceID/collaborate/pause", middleware.RequireAuth(sugar), bwHandlers.PauseExecution)
		app.Post("/v1/workspace/:workspaceID/collaborate/resume", middleware.RequireAuth(sugar), bwHandlers.ResumeExecution)
		app.Post("/v1/workspace/:workspaceID/collaborate/stop", middleware.RequireAuth(sugar), bwHandlers.StopExecution)
		// Preview (embedded live dev-server proxy)
		app.Post("/v1/workspace/:workspaceID/preview/start", middleware.RequireAuth(sugar), bwHandlers.StartPreview)
		app.Delete("/v1/workspace/:workspaceID/preview", middleware.RequireAuth(sugar), bwHandlers.StopPreview)
		app.Get("/v1/workspace/:workspaceID/preview", middleware.RequireAuth(sugar), bwHandlers.GetPreviewStatus)
		// Proxy — all HTTP methods, no auth (bearer forwarded in headers by the iframe)
		app.All("/v1/workspace/:workspaceID/preview/proxy/*", bwHandlers.ProxyPreview)
		// WebSocket
		app.Get("/v1/workspace/:workspaceID/stream", bwGateway.StreamUpgrade, websocket.New(bwGateway.StreamWS))
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

	// ── Admin / Operational endpoints ─────────────────────────────────────────
	// Phase 11: streaming platform stats (no auth for internal use / k8s probes)
	app.Get("/admin/streaming/stats", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "message": "streaming admin not fully wired yet"})
	})

	sugar.Infof("Backend listening on :%s", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// publishRequiresGreen reports whether publishing must be blocked when the final
// validation tree is not green (all stages passed). Default false preserves the
// advisory, non-blocking policy; set PUBLISH_REQUIRE_GREEN=1|true|on|yes to enforce.
func publishRequiresGreen() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PUBLISH_REQUIRE_GREEN"))) {
	case "1", "true", "on", "yes":
		return true
	default:
		return false
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
