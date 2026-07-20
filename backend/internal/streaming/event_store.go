package streaming

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"go.uber.org/zap"
)

// EventStore owns durable persistence and sequence generation for stream events.
// It guarantees persist-before-broadcast: no event reaches a browser without
// first being safely stored in the database.
//
// Sequence generation: on first access per workspace, the store bootstraps from
// MAX(seq) in the DB, then increments atomically in-memory. This avoids a DB
// round-trip per event while guaranteeing uniqueness across server restarts.
type EventStore struct {
	db     *sql.DB
	logger *zap.SugaredLogger

	// Per-workspace sequence counters. Protected by seqMu.
	seqs  map[string]int64
	seqMu sync.Mutex

	// Broadcast hook: called after successful persist with the stamped envelope.
	// Wired to ReplayBuffer.Append + Gateway.Broadcast by main.go.
	onPersist func(workspaceID string, env Envelope)
}

// NewEventStore creates a new EventStore.
func NewEventStore(db *sql.DB, logger *zap.SugaredLogger) *EventStore {
	return &EventStore{
		db:     db,
		logger: logger,
		seqs:   make(map[string]int64),
	}
}

// SetOnPersist registers the post-persist callback.
// Called after every successful Append with the fully-stamped envelope.
func (s *EventStore) SetOnPersist(fn func(workspaceID string, env Envelope)) {
	s.onPersist = fn
}

// Append persists a new event and returns the stamped envelope.
// This is the single entry point for all event production in the platform.
//
// Contract:
//   - Assigns the next seq for this workspace (monotonically increasing)
//   - Writes to stream_events table
//   - Calls onPersist callback (ReplayBuffer + Gateway broadcast)
//   - Returns the fully stamped envelope
func (s *EventStore) Append(
	ctx context.Context,
	workspaceID, channel, event string,
	payload interface{},
	phase string,
	sourceID *string,
) (Envelope, error) {
	// Generate seq
	seq, err := s.nextSeq(ctx, workspaceID)
	if err != nil {
		return Envelope{}, fmt.Errorf("event_store: nextSeq: %w", err)
	}

	now := time.Now()
	id := uuid.New().String()

	// Marshal payload to JSON for DB storage
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("event_store: marshal payload: %w", err)
	}

	// Persist to DB (persist-before-broadcast guarantee)
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO stream_events (id, workspace_id, seq, channel, event, payload, phase, source_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, id, workspaceID, seq, channel, event, payloadJSON, nullableStr(phase), sourceID, now)
	if err != nil {
		// Only retry on PostgreSQL unique constraint violation (code 23505) on
		// (workspace_id, seq) — indicates another instance raced us for the same
		// sequence number. All other errors (connection failures, syntax errors,
		// serialization issues) fail immediately.
		if !isUniqueViolation(err) {
			return Envelope{}, fmt.Errorf("event_store: persist: %w", err)
		}

		s.logger.Warnw("event_store_seq_conflict_retrying",
			"workspace_id", workspaceID, "seq", seq, "error", err)
		seq, err = s.refreshSeq(ctx, workspaceID)
		if err != nil {
			return Envelope{}, fmt.Errorf("event_store: refresh seq after conflict: %w", err)
		}
		id = uuid.New().String()
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO stream_events (id, workspace_id, seq, channel, event, payload, phase, source_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, id, workspaceID, seq, channel, event, payloadJSON, nullableStr(phase), sourceID, now)
		if err != nil {
			return Envelope{}, fmt.Errorf("event_store: persist after retry: %w", err)
		}
	}

	env := Envelope{
		ID:          id,
		WorkspaceID: workspaceID,
		Channel:     channel,
		Event:       event,
		Seq:         seq,
		Ts:          now.UnixMilli(),
		Payload:     payload,
		Phase:       phase,
		SourceID:    sourceID,
	}

	s.logger.Debugw("event_store_persisted",
		"workspace_id", workspaceID, "seq", seq, "channel", channel, "event", event)

	// Post-persist: update replay buffer + broadcast to connected sessions
	if s.onPersist != nil {
		s.onPersist(workspaceID, env)
	}

	return env, nil
}

// ReplayFrom returns events for a workspace after the given seq, filtered by channels.
// If channels is empty, returns all channels. Limited to `limit` events.
func (s *EventStore) ReplayFrom(
	ctx context.Context,
	workspaceID string,
	afterSeq int64,
	channels []string,
	limit int,
) ([]Envelope, error) {
	if limit <= 0 {
		limit = 1000
	}

	var rows *sql.Rows
	var err error

	if len(channels) == 0 {
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, seq, channel, event, payload, phase, created_at
			FROM stream_events
			WHERE workspace_id = $1 AND seq > $2
			ORDER BY seq ASC
			LIMIT $3
		`, workspaceID, afterSeq, limit)
	} else {
		// Use pq.Array for PostgreSQL array parameter
		rows, err = s.db.QueryContext(ctx, `
			SELECT id, seq, channel, event, payload, phase, created_at
			FROM stream_events
			WHERE workspace_id = $1 AND seq > $2 AND channel = ANY($3)
			ORDER BY seq ASC
			LIMIT $4
		`, workspaceID, afterSeq, pq.Array(channels), limit)
	}
	if err != nil {
		return nil, fmt.Errorf("event_store: replay query: %w", err)
	}
	defer rows.Close()

	var envs []Envelope
	for rows.Next() {
		var env Envelope
		var payloadRaw []byte
		var phase sql.NullString
		var createdAt time.Time

		if err := rows.Scan(&env.ID, &env.Seq, &env.Channel, &env.Event, &payloadRaw, &phase, &createdAt); err != nil {
			return nil, fmt.Errorf("event_store: scan row: %w", err)
		}

		env.WorkspaceID = workspaceID
		env.Ts = createdAt.UnixMilli()
		if phase.Valid {
			env.Phase = phase.String
		}

		// Unmarshal payload back to interface{}
		var payload interface{}
		if len(payloadRaw) > 0 {
			_ = json.Unmarshal(payloadRaw, &payload)
		}
		env.Payload = payload

		envs = append(envs, env)
	}

	return envs, rows.Err()
}

// LatestSeq returns the highest seq for a workspace (0 if no events exist).
func (s *EventStore) LatestSeq(ctx context.Context, workspaceID string) (int64, error) {
	var seq int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) FROM stream_events WHERE workspace_id = $1
	`, workspaceID).Scan(&seq)
	return seq, err
}

// CleanupOlderThan deletes events older than the given duration.
// Called by a background goroutine for TTL enforcement.
func (s *EventStore) CleanupOlderThan(ctx context.Context, age time.Duration) (int64, error) {
	cutoff := time.Now().Add(-age)
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM stream_events WHERE created_at < $1
	`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// ── Sequence generation ─────────────────────────────────────────────────────

// nextSeq returns the next sequence number for a workspace.
// Thread-safe: uses mutex + in-memory counter bootstrapped from DB.
func (s *EventStore) nextSeq(ctx context.Context, workspaceID string) (int64, error) {
	s.seqMu.Lock()
	defer s.seqMu.Unlock()

	current, exists := s.seqs[workspaceID]
	if !exists {
		// Bootstrap from DB
		var maxSeq int64
		err := s.db.QueryRowContext(ctx, `
			SELECT COALESCE(MAX(seq), 0) FROM stream_events WHERE workspace_id = $1
		`, workspaceID).Scan(&maxSeq)
		if err != nil {
			return 0, fmt.Errorf("bootstrap seq: %w", err)
		}
		current = maxSeq
		s.seqs[workspaceID] = current
	}

	next := current + 1
	s.seqs[workspaceID] = next
	return next, nil
}

// refreshSeq re-reads the latest seq from DB and returns the next value.
// Used after a conflict (extremely rare in single-instance deployment).
func (s *EventStore) refreshSeq(ctx context.Context, workspaceID string) (int64, error) {
	s.seqMu.Lock()
	defer s.seqMu.Unlock()

	var maxSeq int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(seq), 0) FROM stream_events WHERE workspace_id = $1
	`, workspaceID).Scan(&maxSeq)
	if err != nil {
		return 0, err
	}

	next := maxSeq + 1
	s.seqs[workspaceID] = next
	return next, nil
}

// ── Helpers ─────────────────────────────────────────────────────────────────

func nullableStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// isUniqueViolation returns true if the error is a PostgreSQL unique constraint
// violation (SQLSTATE 23505). Only this error warrants a retry with a fresh seq.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	if pgErr, ok := err.(*pq.Error); ok {
		return pgErr.Code == "23505"
	}
	return false
}
