package streaming

import "sync"

// DefaultBufferCapacity is the maximum number of events buffered per workspace.
const DefaultBufferCapacity = 500

// ReplayBuffer is a per-workspace in-memory ring buffer of recent events.
// It serves as the hot-path cache for replay: if the requested seq is within
// the buffer's range, replay is served entirely from memory without a DB query.
//
// Thread-safe: all methods are safe for concurrent access.
type ReplayBuffer struct {
	mu       sync.RWMutex
	buffers  map[string]*ringBuffer
	capacity int
}

// NewReplayBuffer creates a replay buffer with the given per-workspace capacity.
func NewReplayBuffer(capacity int) *ReplayBuffer {
	if capacity <= 0 {
		capacity = DefaultBufferCapacity
	}
	return &ReplayBuffer{
		buffers:  make(map[string]*ringBuffer),
		capacity: capacity,
	}
}

// Append adds an event to the workspace's ring buffer.
// Called by EventStore.onPersist after successful DB write.
func (rb *ReplayBuffer) Append(workspaceID string, env Envelope) {
	rb.mu.Lock()
	buf, ok := rb.buffers[workspaceID]
	if !ok {
		buf = newRingBuffer(rb.capacity)
		rb.buffers[workspaceID] = buf
	}
	rb.mu.Unlock()

	buf.push(env)
}

// Get returns all buffered events for a workspace with seq > afterSeq.
// Returns nil if the workspace has no buffer or the requested range isn't fully
// covered by the buffer (caller should fall back to DB).
//
// If afterSeq is 0, returns all buffered events (full replay from buffer).
func (rb *ReplayBuffer) Get(workspaceID string, afterSeq int64) ([]Envelope, bool) {
	rb.mu.RLock()
	buf, ok := rb.buffers[workspaceID]
	rb.mu.RUnlock()

	if !ok || buf.len() == 0 {
		return nil, false
	}

	return buf.after(afterSeq)
}

// GetFiltered returns buffered events matching the given channels with seq > afterSeq.
func (rb *ReplayBuffer) GetFiltered(workspaceID string, afterSeq int64, channels map[string]bool) ([]Envelope, bool) {
	envs, ok := rb.Get(workspaceID, afterSeq)
	if !ok {
		return nil, false
	}
	if len(channels) == 0 {
		return envs, true
	}

	filtered := make([]Envelope, 0, len(envs))
	for _, e := range envs {
		if channels[e.Channel] {
			filtered = append(filtered, e)
		}
	}
	return filtered, true
}

// Has checks if a specific seq is in the buffer for a workspace.
func (rb *ReplayBuffer) Has(workspaceID string, seq int64) bool {
	rb.mu.RLock()
	buf, ok := rb.buffers[workspaceID]
	rb.mu.RUnlock()

	if !ok {
		return false
	}
	return buf.contains(seq)
}

// OldestSeq returns the oldest seq in the buffer for a workspace (0 if empty).
func (rb *ReplayBuffer) OldestSeq(workspaceID string) int64 {
	rb.mu.RLock()
	buf, ok := rb.buffers[workspaceID]
	rb.mu.RUnlock()

	if !ok || buf.len() == 0 {
		return 0
	}
	return buf.oldest()
}

// LatestSeq returns the newest seq in the buffer for a workspace (0 if empty).
func (rb *ReplayBuffer) LatestSeq(workspaceID string) int64 {
	rb.mu.RLock()
	buf, ok := rb.buffers[workspaceID]
	rb.mu.RUnlock()

	if !ok || buf.len() == 0 {
		return 0
	}
	return buf.latest()
}

// Clear removes all buffered events for a workspace.
func (rb *ReplayBuffer) Clear(workspaceID string) {
	rb.mu.Lock()
	delete(rb.buffers, workspaceID)
	rb.mu.Unlock()
}

// ── Ring buffer implementation ──────────────────────────────────────────────

type ringBuffer struct {
	mu   sync.RWMutex
	data []Envelope
	cap  int
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{
		data: make([]Envelope, 0, capacity),
		cap:  capacity,
	}
}

func (r *ringBuffer) push(env Envelope) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.data) >= r.cap {
		// Drop the oldest (index 0). Use copy to avoid memory leak.
		copy(r.data, r.data[1:])
		r.data = r.data[:len(r.data)-1]
	}
	r.data = append(r.data, env)
}

func (r *ringBuffer) len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.data)
}

func (r *ringBuffer) oldest() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.data) == 0 {
		return 0
	}
	return r.data[0].Seq
}

func (r *ringBuffer) latest() int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.data) == 0 {
		return 0
	}
	return r.data[len(r.data)-1].Seq
}

func (r *ringBuffer) contains(seq int64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if len(r.data) == 0 {
		return false
	}
	return seq >= r.data[0].Seq && seq <= r.data[len(r.data)-1].Seq
}

// after returns all events with seq > afterSeq.
// Returns (events, true) if the buffer can fully serve the range.
// Returns (nil, false) if afterSeq is older than the buffer's oldest event
// (meaning the caller must fall back to DB for the full range).
func (r *ringBuffer) after(afterSeq int64) ([]Envelope, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.data) == 0 {
		return nil, false
	}

	// If afterSeq is 0, return everything in the buffer
	if afterSeq == 0 {
		out := make([]Envelope, len(r.data))
		copy(out, r.data)
		return out, true
	}

	// If the requested start is older than our buffer, we can't serve it fully
	if afterSeq < r.data[0].Seq-1 {
		return nil, false
	}

	// Binary search for the starting position
	start := 0
	for i, e := range r.data {
		if e.Seq > afterSeq {
			start = i
			break
		}
		if i == len(r.data)-1 {
			// Everything in buffer is <= afterSeq, nothing to return
			return []Envelope{}, true
		}
	}

	out := make([]Envelope, len(r.data)-start)
	copy(out, r.data[start:])
	return out, true
}
