package pipeline

import (
	"context"
	"time"

	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
)

// PauseCheckerImpl implements PauseChecker by querying ExecutionRepository.
type PauseCheckerImpl struct {
	execRepo *repository.ExecutionRepository
}

// NewPauseChecker creates a new PauseChecker backed by the given ExecutionRepository.
func NewPauseChecker(execRepo *repository.ExecutionRepository) PauseChecker {
	return &PauseCheckerImpl{execRepo: execRepo}
}

// IsPaused returns true if the execution status is "paused".
// Fails open on DB query errors (returns false so the pipeline continues).
func (p *PauseCheckerImpl) IsPaused(ctx context.Context, execID string) bool {
	exec, err := p.execRepo.GetExecution(ctx, execID)
	if err != nil {
		return false
	}
	return exec.Status == "paused"
}

// IsCancelled returns true if the execution status is "cancelled".
// Fails open on DB query errors (returns false so the pipeline continues).
func (p *PauseCheckerImpl) IsCancelled(ctx context.Context, execID string) bool {
	exec, err := p.execRepo.GetExecution(ctx, execID)
	if err != nil {
		return false
	}
	return exec.Status == "cancelled"
}

// WaitForResume blocks until the execution is resumed or cancelled.
// It polls the execution status every 1 second and also selects on ctx.Done()
// for fast unblock when Stop cancels the context.
// Returns true if cancelled (caller should abort), false if resumed.
func (p *PauseCheckerImpl) WaitForResume(ctx context.Context, execID string) (cancelled bool) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return true
		case <-ticker.C:
			if p.IsCancelled(ctx, execID) {
				return true
			}
			if !p.IsPaused(ctx, execID) {
				return false
			}
		}
	}
}
