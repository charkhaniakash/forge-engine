package pipeline

import (
	"context"
	"sync"
)

// registryEntry holds a cancellable context and its cancel function for a single pipeline execution.
type registryEntry struct {
	ctx    context.Context
	cancel context.CancelFunc
}

// ContextRegistry manages cancellable contexts for active pipeline runs.
// It is safe for concurrent use from multiple goroutines.
type ContextRegistry struct {
	mu      sync.Mutex
	entries map[string]*registryEntry
}

// NewContextRegistry creates a new, empty ContextRegistry.
func NewContextRegistry() *ContextRegistry {
	return &ContextRegistry{
		entries: make(map[string]*registryEntry),
	}
}

// Register creates a new cancellable context for the given execution ID,
// derived from the provided parent context. Returns the child context.
func (r *ContextRegistry) Register(parent context.Context, execID string) context.Context {
	ctx, cancel := context.WithCancel(parent)

	r.mu.Lock()
	r.entries[execID] = &registryEntry{
		ctx:    ctx,
		cancel: cancel,
	}
	r.mu.Unlock()

	return ctx
}

// Cancel cancels the context for the given execution ID.
// It is a no-op if the execution ID does not exist in the registry (idempotent).
func (r *ContextRegistry) Cancel(execID string) {
	r.mu.Lock()
	entry, ok := r.entries[execID]
	r.mu.Unlock()

	if ok {
		entry.cancel()
	}
}

// Get retrieves the context for the given execution ID.
// Returns nil if the execution ID is not found in the registry.
func (r *ContextRegistry) Get(execID string) context.Context {
	r.mu.Lock()
	entry, ok := r.entries[execID]
	r.mu.Unlock()

	if ok {
		return entry.ctx
	}
	return nil
}

// Deregister removes the entry for the given execution ID from the registry.
// Should be called when the pipeline completes (success, failure, or cancellation)
// to prevent memory leaks. It is a no-op if the execution ID does not exist.
func (r *ContextRegistry) Deregister(execID string) {
	r.mu.Lock()
	delete(r.entries, execID)
	r.mu.Unlock()
}
