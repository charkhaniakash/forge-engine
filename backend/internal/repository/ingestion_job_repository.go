package repository

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/google/uuid"
)

type IngestionJobRepository struct {
	db *sql.DB
}

func NewIngestionJobRepository(db *sql.DB) *IngestionJobRepository {
	return &IngestionJobRepository{db: db}
}

// Create enqueues a new ingestion job and returns it.
func (r *IngestionJobRepository) Create(
	ctx context.Context,
	repoID string,
	commitSHA string,
	triggerType string,
) (*models.IngestionJob, error) {
	id := uuid.New().String()
	now := time.Now()

	query := `
		INSERT INTO ingestion_jobs
			(id, repo_id, commit_sha, trigger_type, status, queued_at, processed_chunks, created_at, updated_at)
		VALUES
			($1, $2, $3, $4, 'queued', $5, 0, $5, $5)
		RETURNING
			id, repo_id, commit_sha, trigger_type, status, progress_stage,
			queued_at, started_at, finished_at, worker_id,
			total_chunks, processed_chunks, error, created_at, updated_at
	`
	row := r.db.QueryRowContext(ctx, query, id, repoID, commitSHA, triggerType, now)
	return scanJob(row)
}

// GetByID returns a single job by its UUID.
func (r *IngestionJobRepository) GetByID(ctx context.Context, id string) (*models.IngestionJob, error) {
	query := `
		SELECT id, repo_id, commit_sha, trigger_type, status, progress_stage,
		       queued_at, started_at, finished_at, worker_id,
		       total_chunks, processed_chunks, error, created_at, updated_at
		FROM ingestion_jobs
		WHERE id = $1
	`
	row := r.db.QueryRowContext(ctx, query, id)
	return scanJob(row)
}

// GetLatestForRepo returns the most recently queued job for a repo regardless of status.
func (r *IngestionJobRepository) GetLatestForRepo(ctx context.Context, repoID string) (*models.IngestionJob, error) {
	query := `
		SELECT id, repo_id, commit_sha, trigger_type, status, progress_stage,
		       queued_at, started_at, finished_at, worker_id,
		       total_chunks, processed_chunks, error, created_at, updated_at
		FROM ingestion_jobs
		WHERE repo_id = $1
		ORDER BY queued_at DESC
		LIMIT 1
	`
	row := r.db.QueryRowContext(ctx, query, repoID)
	return scanJob(row)
}

// UpdateCommitSHA writes the resolved commit SHA back to the job row.
// Called by the worker after git clone resolves the actual HEAD SHA —
// which may differ from the SHA stored at enqueue time when the job
// was triggered with an empty commitSHA (e.g. manual trigger).
// This resolved SHA is what gets stored in qa_sessions.commit_sha.
func (r *IngestionJobRepository) UpdateCommitSHA(ctx context.Context, id string, commitSHA string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET commit_sha = $2, updated_at = NOW()
		WHERE id = $1
	`, id, commitSHA)
	return err
}

// GetLatestDoneForRepo returns the most recent successfully completed job for a repo.
// Phase 4 retrieval should use this to find the live queryable snapshot.
func (r *IngestionJobRepository) GetLatestDoneForRepo(ctx context.Context, repoID string) (*models.IngestionJob, error) {
	query := `
		SELECT id, repo_id, commit_sha, trigger_type, status, progress_stage,
		       queued_at, started_at, finished_at, worker_id,
		       total_chunks, processed_chunks, error, created_at, updated_at
		FROM ingestion_jobs
		WHERE repo_id = $1 AND status = 'done'
		ORDER BY finished_at DESC
		LIMIT 1
	`
	row := r.db.QueryRowContext(ctx, query, repoID)
	return scanJob(row)
}

// MarkRunning transitions a job from queued → running, recording the worker identity.
// Returns ErrJobSuperseded if the job has already been marked superseded.
func (r *IngestionJobRepository) MarkRunning(ctx context.Context, id string, workerID string) error {
	result, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET status = 'running', started_at = NOW(), worker_id = $2, updated_at = NOW()
		WHERE id = $1 AND status = 'queued'
	`, id, workerID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		// Either already running (duplicate pickup) or superseded.
		job, err := r.GetByID(ctx, id)
		if err != nil {
			return err
		}
		if job.Status == "superseded" {
			return ErrJobSuperseded
		}
		return fmt.Errorf("job %s could not be marked running (status: %s)", id, job.Status)
	}
	return nil
}

// UpdateProgress updates the progress stage and chunk counters mid-job.
func (r *IngestionJobRepository) UpdateProgress(
	ctx context.Context,
	id string,
	stage string,
	processedChunks int,
	totalChunks *int,
) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET progress_stage = $2,
		    processed_chunks = $3,
		    total_chunks = COALESCE($4, total_chunks),
		    updated_at = NOW()
		WHERE id = $1
	`, id, stage, processedChunks, totalChunks)
	return err
}

// MarkDone transitions a running job to done.
func (r *IngestionJobRepository) MarkDone(ctx context.Context, id string, totalChunks int) error {
	completed := "completed"
	_, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET status = 'done', progress_stage = $2,
		    finished_at = NOW(), total_chunks = $3, processed_chunks = $3,
		    updated_at = NOW()
		WHERE id = $1
	`, id, completed, totalChunks)
	return err
}

// MarkFailed transitions a job to failed with an error message.
func (r *IngestionJobRepository) MarkFailed(ctx context.Context, id string, errMsg string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET status = 'failed', error = $2, finished_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, errMsg)
	return err
}

// SupersedeOlderJobs marks all queued or running jobs for a repo as superseded,
// except for the job with the given excludeID (the newly enqueued one).
// Returns the number of jobs superseded.
func (r *IngestionJobRepository) SupersedeOlderJobs(ctx context.Context, repoID string, excludeID string) (int64, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE ingestion_jobs
		SET status = 'superseded', updated_at = NOW()
		WHERE repo_id = $1
		  AND id != $2
		  AND status IN ('queued', 'running')
	`, repoID, excludeID)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// IsSuperseded returns true if the given job has been marked superseded.
func (r *IngestionJobRepository) IsSuperseded(ctx context.Context, id string) (bool, error) {
	job, err := r.GetByID(ctx, id)
	if err != nil {
		return false, err
	}
	return job.Status == "superseded", nil
}

// scanJob scans a single row into an IngestionJob, handling nullable columns.
func scanJob(row *sql.Row) (*models.IngestionJob, error) {
	var j models.IngestionJob
	var progressStage sql.NullString
	var startedAt, finishedAt sql.NullTime
	var workerID sql.NullString
	var totalChunks sql.NullInt32
	var jobError sql.NullString

	err := row.Scan(
		&j.ID,
		&j.RepoID,
		&j.CommitSHA,
		&j.TriggerType,
		&j.Status,
		&progressStage,
		&j.QueuedAt,
		&startedAt,
		&finishedAt,
		&workerID,
		&totalChunks,
		&j.ProcessedChunks,
		&jobError,
		&j.CreatedAt,
		&j.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	if progressStage.Valid {
		j.ProgressStage = &progressStage.String
	}
	if startedAt.Valid {
		j.StartedAt = &startedAt.Time
	}
	if finishedAt.Valid {
		j.FinishedAt = &finishedAt.Time
	}
	if workerID.Valid {
		j.WorkerID = &workerID.String
	}
	if totalChunks.Valid {
		n := int(totalChunks.Int32)
		j.TotalChunks = &n
	}
	if jobError.Valid {
		j.Error = &jobError.String
	}

	return &j, nil
}

var ErrJobSuperseded = fmt.Errorf("job has been superseded by a newer ingestion")

// BackfillCommitSHAFromChunks updates ingestion_jobs.commit_sha for jobs that
// were completed before the UpdateCommitSHA fix was added. It queries code_chunks
// to find the actual commit_sha for each done job with an empty commit_sha.
func (r *IngestionJobRepository) BackfillCommitSHAFromChunks(ctx context.Context) (int, error) {
	query := `
		UPDATE ingestion_jobs ij
		SET commit_sha = cc.commit_sha, updated_at = NOW()
		FROM (
			SELECT DISTINCT job_id, commit_sha
			FROM code_chunks
			WHERE commit_sha IS NOT NULL
		) cc
		WHERE ij.id = cc.job_id
		  AND ij.status = 'done'
		  AND ij.commit_sha = ''
	`
	result, err := r.db.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}
