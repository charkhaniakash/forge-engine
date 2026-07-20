package streaming

import (
	"context"
	"time"

	"go.uber.org/zap"
)

// DefaultRetention is the default TTL for stream events.
const DefaultRetention = 14 * 24 * time.Hour // 14 days

// StartCleanupWorker runs a background goroutine that periodically deletes
// stream events older than the retention period. Stops when ctx is cancelled.
func StartCleanupWorker(ctx context.Context, store *EventStore, retention time.Duration, logger *zap.SugaredLogger) {
	if retention <= 0 {
		retention = DefaultRetention
	}

	ticker := time.NewTicker(1 * time.Hour) // run cleanup every hour
	defer ticker.Stop()

	logger.Infow("stream_cleanup_worker_started", "retention", retention.String())

	for {
		select {
		case <-ctx.Done():
			logger.Infow("stream_cleanup_worker_stopped")
			return
		case <-ticker.C:
			deleted, err := store.CleanupOlderThan(ctx, retention)
			if err != nil {
				logger.Warnw("stream_cleanup_failed", "error", err)
				continue
			}
			if deleted > 0 {
				logger.Infow("stream_cleanup_complete", "deleted", deleted)
			}
		}
	}
}
