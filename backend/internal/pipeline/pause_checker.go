package pipeline

import "context"

// PauseChecker provides pause/cancel awareness to orchestrators without
// coupling them to the ExecutionRepository directly.
type PauseChecker interface {
	// IsPaused returns true if the execution is currently paused.
	// Returns false on DB query errors (fail-open).
	IsPaused(ctx context.Context, execID string) bool

	// IsCancelled returns true if the execution is cancelled.
	// Returns false on DB query errors (fail-open).
	IsCancelled(ctx context.Context, execID string) bool

	// WaitForResume blocks until the execution is resumed or cancelled.
	// Returns true if cancelled (caller should abort), false if resumed.
	// Selects on both a 1-second poll ticker and ctx.Done() for fast unblock on Stop.
	WaitForResume(ctx context.Context, execID string) (cancelled bool)
}
