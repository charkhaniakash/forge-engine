package handlers

import (
	"github.com/gofiber/fiber/v2"
	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// IngestionHandlers exposes job status and manual trigger endpoints.
// Push-triggered ingestion is handled directly in GitHubHandlers.Webhook
// by calling EnqueueForRepo.
type IngestionHandlers struct {
	jobRepo  *repository.IngestionJobRepository
	repoRepo *repository.GitHubRepoRepository
	worker   *ingestion.JobWorker
	logger   *zap.SugaredLogger
}

func NewIngestionHandlers(
	jobRepo *repository.IngestionJobRepository,
	repoRepo *repository.GitHubRepoRepository,
	worker *ingestion.JobWorker,
	logger *zap.SugaredLogger,
) *IngestionHandlers {
	return &IngestionHandlers{
		jobRepo:  jobRepo,
		repoRepo: repoRepo,
		worker:   worker,
		logger:   logger,
	}
}

// GetIndexStatus returns the latest ingestion job for a repo.
//
// GET /v1/github/repos/:repoID/index/status
func (h *IngestionHandlers) GetIndexStatus(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	repoID := c.Params("repoID")

	ctx := c.Context()

	job, err := h.jobRepo.GetLatestForRepo(ctx, repoID)
	if err != nil {
		h.logger.Infow("no_ingestion_job_for_repo",
			"repo_id", repoID,
			"trace_id", traceID,
		)
		return c.JSON(fiber.Map{
			"repo_id": repoID,
			"status":  "not_indexed",
			"job":     nil,
		})
	}

	return c.JSON(fiber.Map{
		"repo_id": repoID,
		"status":  job.Status,
		"job":     job,
	})
}

// TriggerIndex manually enqueues an ingestion job for a repo.
// The frontend calls this when a user clicks "Index Repository".
//
// POST /v1/github/repos/:repoID/index/trigger
func (h *IngestionHandlers) TriggerIndex(c *fiber.Ctx) error {
	traceID := c.Locals("trace_id").(string)
	repoID := c.Params("repoID")

	ctx := c.Context()

	repo, err := h.repoRepo.GetByID(ctx, repoID)
	if err != nil {
		h.logger.Warnw("trigger_index_repo_not_found",
			"repo_id", repoID,
			"error", err,
			"trace_id", traceID,
		)
		return c.Status(404).JSON(fiber.Map{"error": "repo not found"})
	}

	// Use last_commit_sha if available, otherwise empty — the worker will
	// clone HEAD and resolve the SHA.
	commitSHA := ""
	if repo.LastCommitSHA != nil {
		commitSHA = *repo.LastCommitSHA
	}

	job, err := h.jobRepo.Create(ctx, repoID, commitSHA, "manual")
	if err != nil {
		h.logger.Errorw("trigger_index_create_job_failed",
			"repo_id", repoID,
			"error", err,
			"trace_id", traceID,
		)
		return c.Status(500).JSON(fiber.Map{"error": "failed to create ingestion job"})
	}

	// Supersede any older queued/running jobs for this repo.
	superseded, err := h.jobRepo.SupersedeOlderJobs(ctx, repoID, job.ID)
	if err != nil {
		h.logger.Warnw("supersede_older_jobs_failed",
			"repo_id", repoID,
			"error", err,
			"trace_id", traceID,
		)
	}

	if err := h.worker.Enqueue(ctx, job.ID); err != nil {
		h.logger.Errorw("trigger_index_enqueue_failed",
			"job_id", job.ID,
			"error", err,
			"trace_id", traceID,
		)
		_ = h.jobRepo.MarkFailed(ctx, job.ID, "failed to enqueue: "+err.Error())
		return c.Status(500).JSON(fiber.Map{"error": "failed to enqueue job"})
	}

	h.logger.Infow("index_triggered",
		"job_id", job.ID,
		"repo_id", repoID,
		"commit_sha", commitSHA,
		"superseded_count", superseded,
		"trace_id", traceID,
	)

	return c.Status(202).JSON(fiber.Map{
		"job_id":          job.ID,
		"status":          "queued",
		"superseded_jobs": superseded,
	})
}
