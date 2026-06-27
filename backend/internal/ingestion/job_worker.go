package ingestion

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/github"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

const (
	// RedisIngestionQueue is the Redis list key for ingestion job IDs.
	RedisIngestionQueue = "forge:ingestion:queue"

	// IngestTimeout is the maximum wall-clock time allowed for a single
	// ingestion job (clone + parse + embed + persist). Large repos will need
	// this raised — it can be made config-driven in a later iteration.
	IngestTimeout = 30 * time.Minute
)

// JobWorker consumes ingestion job IDs from a Redis queue, orchestrates the
// full clone → agent-ingest pipeline, and writes all status transitions to the
// database. It owns:
//   - Redis queue lifecycle (BLPOP, retry on transient errors)
//   - Supersede checks (before clone, after clone — never mid-embedding)
//   - Clone directory creation and cleanup
//   - Progress updates from Agent NDJSON stream → DB
//   - All ingestion_jobs status transitions
//
// The Agent owns: parsing, chunking, embedding, writing code_chunks.
// See ADR 0004 for the boundary contract.
type JobWorker struct {
	redis          *redis.Client
	jobRepo        *repository.IngestionJobRepository
	installRepo    *repository.GitHubInstallationRepository
	repoRepo       *repository.GitHubRepoRepository
	tokenCache     *github.TokenCache
	cloner         *Cloner
	agentClient    *AgentClient
	logger         *zap.SugaredLogger
	jwtSecret      string
	workerID       string
	concurrency    int
}

// WorkerConfig holds all dependencies for building a JobWorker.
type WorkerConfig struct {
	Redis       *redis.Client
	JobRepo     *repository.IngestionJobRepository
	InstallRepo *repository.GitHubInstallationRepository
	RepoRepo    *repository.GitHubRepoRepository
	TokenCache  *github.TokenCache
	Cloner      *Cloner
	AgentClient *AgentClient
	Logger      *zap.SugaredLogger
	JWTSecret   string
	Concurrency int // number of parallel workers; defaults to 2
}

// NewJobWorker creates a JobWorker from config.
func NewJobWorker(cfg WorkerConfig) *JobWorker {
	concurrency := cfg.Concurrency
	if concurrency <= 0 {
		concurrency = 2
	}
	workerID := fmt.Sprintf("%s:%d", hostname(), os.Getpid())
	return &JobWorker{
		redis:       cfg.Redis,
		jobRepo:     cfg.JobRepo,
		installRepo: cfg.InstallRepo,
		repoRepo:    cfg.RepoRepo,
		tokenCache:  cfg.TokenCache,
		cloner:      cfg.Cloner,
		agentClient: cfg.AgentClient,
		logger:      cfg.Logger,
		jwtSecret:   cfg.JWTSecret,
		workerID:    workerID,
		concurrency: concurrency,
	}
}

// Start launches the worker pool. It blocks until ctx is cancelled.
// Each goroutine loops on BLPOP, processing one job at a time.
func (w *JobWorker) Start(ctx context.Context) {
	w.logger.Infow("ingestion_worker_starting",
		"worker_id", w.workerID,
		"concurrency", w.concurrency,
	)

	done := make(chan struct{})
	for i := 0; i < w.concurrency; i++ {
		go func(id int) {
			w.loop(ctx, fmt.Sprintf("%s/g%d", w.workerID, id))
			done <- struct{}{}
		}(i)
	}

	<-ctx.Done()
	// Drain done signals so goroutines can exit cleanly.
	for i := 0; i < w.concurrency; i++ {
		<-done
	}
	w.logger.Infow("ingestion_worker_stopped", "worker_id", w.workerID)
}

// Enqueue pushes a job ID onto the Redis queue and returns immediately.
// The job row must already exist in the database before calling this.
func (w *JobWorker) Enqueue(ctx context.Context, jobID string) error {
	return w.redis.RPush(ctx, RedisIngestionQueue, jobID).Err()
}

// loop is the per-goroutine work loop. It blocks on BLPOP and processes one
// job per iteration.
func (w *JobWorker) loop(ctx context.Context, workerID string) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// BLPOP with a 5-second timeout so we can check ctx.Done() periodically.
		result, err := w.redis.BLPop(ctx, 5*time.Second, RedisIngestionQueue).Result()
		if err == redis.Nil {
			continue // timeout — loop and check ctx again
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			w.logger.Errorw("redis_blpop_error", "error", err, "worker_id", workerID)
			time.Sleep(2 * time.Second) // back off on Redis errors
			continue
		}

		if len(result) < 2 {
			continue
		}
		jobID := result[1]

		w.processJob(ctx, jobID, workerID)
	}
}

// processJob runs the full ingestion pipeline for a single job.
// It is the only place that writes ingestion_jobs status transitions.
func (w *JobWorker) processJob(ctx context.Context, jobID string, workerID string) {
	log := w.logger.With("job_id", jobID, "worker_id", workerID)

	// ── 1. Load job ──────────────────────────────────────────────────────────
	job, err := w.jobRepo.GetByID(ctx, jobID)
	if err != nil {
		log.Errorw("job_load_failed", "error", err)
		return
	}

	log = log.With("repo_id", job.RepoID, "commit_sha", job.CommitSHA)

	// ── 2. Supersede check #1: before we do any work ─────────────────────────
	if job.Status == "superseded" {
		log.Infow("job_superseded_before_start")
		return
	}

	// ── 3. Transition to running ──────────────────────────────────────────────
	if err := w.jobRepo.MarkRunning(ctx, jobID, workerID); err != nil {
		if err == repository.ErrJobSuperseded {
			log.Infow("job_superseded_on_mark_running")
			return
		}
		log.Errorw("mark_running_failed", "error", err)
		return
	}

	log.Infow("job_started")

	// ── 4. Look up the repo and get a fresh installation token ───────────────
	repo, err := w.repoRepo.GetByID(ctx, job.RepoID)
	if err != nil {
		log.Errorw("repo_load_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("repo not found: %v", err))
		return
	}

	installation, err := w.installRepo.GetByID(ctx, repo.InstallationID)
	if err != nil {
		log.Errorw("installation_load_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("installation not found: %v", err))
		return
	}

	token, err := w.tokenCache.GetInstallationToken(ctx, installation.GitHubInstallationID)
	if err != nil {
		log.Errorw("token_fetch_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("failed to get installation token: %v", err))
		return
	}

	// ── 5. Update progress stage: cloning ────────────────────────────────────
	_ = w.jobRepo.UpdateProgress(ctx, jobID, "cloning", 0, nil)

	// ── 6. Clone ─────────────────────────────────────────────────────────────
	cloneCtx, cloneCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cloneCancel()

	cloneURL := fmt.Sprintf("https://x-access-token:%s@github.com/%s.git", token, repo.RepoFullName)
	cloneResult, err := w.cloner.Clone(cloneCtx, cloneURL, job.CommitSHA, token)
	if err != nil {
		log.Errorw("clone_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("clone failed: %v", err))
		return
	}
	// Always clean up the clone directory, success or failure.
	defer w.cloner.Cleanup(cloneResult.Dir)

	// ── 7. Supersede check #2: after clone, before calling the Agent ─────────
	// We do NOT check again after this point (e.g. mid-embedding) — stopping
	// mid-embedding leaves partial state. See ADR 0004.
	superseded, err := w.jobRepo.IsSuperseded(ctx, jobID)
	if err != nil {
		log.Errorw("supersede_check_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("supersede check failed: %v", err))
		return
	}
	if superseded {
		log.Infow("job_superseded_after_clone")
		return // clone dir cleaned up by defer above
	}

	// ── 8. Build agent JWT and call Agent (streaming) ────────────────────────
	agentToken, err := w.signToken(jobID)
	if err != nil {
		log.Errorw("agent_token_sign_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("failed to sign agent token: %v", err))
		return
	}

	ingestCtx, ingestCancel := context.WithTimeout(ctx, IngestTimeout)
	defer ingestCancel()

	ingestCtx = WithTraceID(ingestCtx, jobID)

	ingestReq := IngestRequest{
		JobID:     jobID,
		RepoID:    job.RepoID,
		CommitSHA: cloneResult.CommitSHA,
		ClonePath: cloneResult.Dir,
	}

	var lastProcessed, lastTotal int
	var finalTotalChunks int

	err = w.agentClient.Ingest(ingestCtx, ingestReq, agentToken, func(event ProgressEvent) {
		switch event.Event {
		case "progress":
			lastProcessed = event.Processed
			if event.Total > 0 {
				lastTotal = event.Total
			}
			total := &lastTotal
			if lastTotal == 0 {
				total = nil
			}
			if updateErr := w.jobRepo.UpdateProgress(ctx, jobID, event.Stage, lastProcessed, total); updateErr != nil {
				log.Warnw("progress_update_failed", "error", updateErr)
			}

		case "done":
			finalTotalChunks = event.TotalChunks
			log.Infow("agent_ingest_done", "total_chunks", finalTotalChunks)

		case "error":
			log.Errorw("agent_ingest_error", "message", event.Message)
		}
	})

	if err != nil {
		log.Errorw("agent_ingest_failed", "error", err)
		_ = w.jobRepo.MarkFailed(ctx, jobID, fmt.Sprintf("agent ingest failed: %v", err))
		return
	}

	// ── 9. Mark done ─────────────────────────────────────────────────────────
	if err := w.jobRepo.MarkDone(ctx, jobID, finalTotalChunks); err != nil {
		log.Errorw("mark_done_failed", "error", err)
		return
	}

	log.Infow("job_completed", "total_chunks", finalTotalChunks)
}

// signToken creates a short-lived JWT for the Backend→Agent call (ADR 0001).
func (w *JobWorker) signToken(traceID string) (string, error) {
	secret := w.jwtSecret
	if secret == "" {
		secret = "phase-0-insecure-default"
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":      "backend",
		"trace_id": traceID,
		"iat":      time.Now().Unix(),
		"exp":      time.Now().Add(30 * time.Minute).Unix(),
	})
	return token.SignedString([]byte(secret))
}

// hostname returns the system hostname, falling back to "unknown".
func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

// EnqueueForRepo creates a new ingestion job for a repo + commit SHA and pushes
// it onto the Redis queue. It supersedes older queued/running jobs for the same
// repo. Safe to call from the webhook handler goroutine.
func (w *JobWorker) EnqueueForRepo(
	ctx context.Context,
	jobRepo *repository.IngestionJobRepository,
	repoID string,
	commitSHA string,
	triggerType string,
) error {
	job, err := jobRepo.Create(ctx, repoID, commitSHA, triggerType)
	if err != nil {
		return fmt.Errorf("failed to create ingestion job: %w", err)
	}

	if _, err := jobRepo.SupersedeOlderJobs(ctx, repoID, job.ID); err != nil {
		// Non-fatal — log and continue.
		w.logger.Warnw("supersede_older_jobs_failed",
			"repo_id", repoID,
			"job_id", job.ID,
			"error", err,
		)
	}

	return w.Enqueue(ctx, job.ID)
}
