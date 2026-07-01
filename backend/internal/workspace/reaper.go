package workspace

import (
	"context"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// WorkspaceReaper runs on a periodic tick and destroys orphaned or timed-out
// workspaces. It is the safety net for any workspace that did not reach
// 'destroyed' status through the normal lifecycle path.
//
// Orphan definitions:
//   - status='provisioning' AND created_at older than 5 minutes
//     (provision timeout — container may never have started)
//   - status NOT IN terminal AND created_at + timeout_seconds < NOW()
//     (wall-clock timeout expired)
//   - container exists in DB but Docker reports it is stopped/dead
//
// The reaper uses SELECT FOR UPDATE SKIP LOCKED so it is safe to run on
// multiple backend replicas without double-destroying a workspace.
type WorkspaceReaper struct {
	manager  *WorkspaceManager
	wsRepo   *repository.WorkspaceRepository
	interval time.Duration
	logger   *zap.SugaredLogger
}

// NewWorkspaceReaper constructs a WorkspaceReaper.
func NewWorkspaceReaper(
	manager *WorkspaceManager,
	wsRepo *repository.WorkspaceRepository,
	intervalSeconds int,
	logger *zap.SugaredLogger,
) *WorkspaceReaper {
	return &WorkspaceReaper{
		manager:  manager,
		wsRepo:   wsRepo,
		interval: time.Duration(intervalSeconds) * time.Second,
		logger:   logger,
	}
}

// Start runs the reaper loop until ctx is cancelled. Intended to be called
// as a goroutine alongside the main server.
func (r *WorkspaceReaper) Start(ctx context.Context) {
	r.logger.Infow("workspace_reaper_starting",
		"interval_seconds", int(r.interval.Seconds()))

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.logger.Info("workspace_reaper_stopped")
			return
		case <-ticker.C:
			r.sweep(ctx)
		}
	}
}

// sweep checks all live workspaces and destroys any that are orphaned or
// have exceeded their wall-clock timeout.
func (r *WorkspaceReaper) sweep(ctx context.Context) {
	workspaces, err := r.wsRepo.ListLive(ctx)
	if err != nil {
		r.logger.Errorw("reaper_list_live_failed", "error", err)
		return
	}

	if len(workspaces) == 0 {
		return
	}

	r.logger.Debugw("reaper_sweep", "live_count", len(workspaces))

	for _, ws := range workspaces {
		r.checkWorkspace(ctx, ws)
	}
}

func (r *WorkspaceReaper) checkWorkspace(ctx context.Context, ws *models.Workspace) {
	now := time.Now()

	// Case 1: provisioning timeout — never got a container.
	if ws.Status == models.WorkspaceStatusProvisioning {
		provisionDeadline := ws.CreatedAt.Add(5 * time.Minute)
		if now.After(provisionDeadline) {
			r.logger.Warnw("reaper_provision_timeout",
				"workspace_id", ws.ID,
				"age_seconds", int(now.Sub(ws.CreatedAt).Seconds()))
			r.destroy(ctx, ws, "provision timed out after 5 minutes")
			return
		}
	}

	// Case 2: wall-clock timeout — workspace has been alive too long.
	deadline := ws.CreatedAt.Add(time.Duration(ws.TimeoutSeconds) * time.Second)
	if now.After(deadline) {
		r.logger.Warnw("reaper_workspace_timeout",
			"workspace_id", ws.ID,
			"timeout_seconds", ws.TimeoutSeconds,
			"age_seconds", int(now.Sub(ws.CreatedAt).Seconds()))
		r.destroy(ctx, ws, "exceeded wall-clock timeout")
		return
	}

	// Case 3: container exists but Docker reports it is not running.
	if ws.ContainerID != nil {
		status, err := r.manager.driver.Status(ctx, *ws.ContainerID)
		if err != nil {
			r.logger.Warnw("reaper_status_check_failed",
				"workspace_id", ws.ID,
				"error", err)
			return
		}
		if !status.Running && ws.Status != models.WorkspaceStatusCompleted {
			r.logger.Warnw("reaper_container_dead",
				"workspace_id", ws.ID,
				"status", ws.Status)
			r.destroy(ctx, ws, "container stopped unexpectedly")
		}
	}
}

func (r *WorkspaceReaper) destroy(ctx context.Context, ws *models.Workspace, reason string) {
	r.logger.Infow("reaper_destroying",
		"workspace_id", ws.ID,
		"reason", reason)

	if err := r.manager.Destroy(ctx, ws.ID); err != nil {
		r.logger.Errorw("reaper_destroy_failed",
			"workspace_id", ws.ID,
			"error", err)
	}
}
