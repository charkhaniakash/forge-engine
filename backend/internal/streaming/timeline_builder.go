package streaming

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"go.uber.org/zap"
)

// TimelineSnapshot is a compressed summary of a workspace's execution history.
// Sent as the first event to fresh-connecting clients instead of replaying
// thousands of individual events, enabling instant hydration.
type TimelineSnapshot struct {
	WorkspaceID string          `json:"workspace_id"`
	Phases      []PhaseSnapshot `json:"phases"`
	LatestSeq   int64           `json:"latest_seq"`
	TotalEvents int             `json:"total_events"`
	GeneratedAt int64           `json:"generated_at"`
}

// PhaseSnapshot summarizes one lifecycle phase.
type PhaseSnapshot struct {
	Phase      string  `json:"phase"`
	Status     string  `json:"status"`      // running | completed | failed | cancelled
	StartedAt  *int64  `json:"started_at"`  // ms epoch
	EndedAt    *int64  `json:"ended_at"`    // ms epoch
	DurationMs *int64  `json:"duration_ms"` // computed
	EventCount int     `json:"event_count"`
	Summary    string  `json:"summary,omitempty"` // human-readable one-liner
	LastEvent  *string `json:"last_event,omitempty"`
}

// TimelineBuilder materializes compressed timeline snapshots from stored events.
// Used for "fast-forward to latest state" on fresh browser connections.
type TimelineBuilder struct {
	db     *sql.DB
	logger *zap.SugaredLogger
}

// NewTimelineBuilder creates a timeline builder.
func NewTimelineBuilder(db *sql.DB, logger *zap.SugaredLogger) *TimelineBuilder {
	return &TimelineBuilder{db: db, logger: logger}
}

// BuildSnapshot generates a complete timeline snapshot for a workspace.
// It aggregates stream_events by phase and extracts boundaries + summaries.
func (tb *TimelineBuilder) BuildSnapshot(ctx context.Context, workspaceID string) (*TimelineSnapshot, error) {
	rows, err := tb.db.QueryContext(ctx, `
		SELECT phase, event, payload, seq, created_at
		FROM stream_events
		WHERE workspace_id = $1 AND phase IS NOT NULL
		ORDER BY seq ASC
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type phaseState struct {
		phase      string
		status     string
		startedAt  *int64
		endedAt    *int64
		eventCount int
		lastEvent  string
		summary    string
	}

	phases := make(map[string]*phaseState)
	phaseOrder := []string{}
	var latestSeq int64
	totalEvents := 0

	for rows.Next() {
		var phase sql.NullString
		var event string
		var payloadRaw []byte
		var seq int64
		var createdAt time.Time

		if err := rows.Scan(&phase, &event, &payloadRaw, &seq, &createdAt); err != nil {
			return nil, err
		}

		if !phase.Valid || phase.String == "" {
			continue
		}

		totalEvents++
		if seq > latestSeq {
			latestSeq = seq
		}

		p, ok := phases[phase.String]
		if !ok {
			p = &phaseState{phase: phase.String, status: "running"}
			phases[phase.String] = p
			phaseOrder = append(phaseOrder, phase.String)
		}

		tsMs := createdAt.UnixMilli()
		if p.startedAt == nil {
			p.startedAt = &tsMs
		}
		p.endedAt = &tsMs
		p.eventCount++
		p.lastEvent = event

		// Extract status from lifecycle events
		var payload map[string]interface{}
		if len(payloadRaw) > 0 {
			_ = json.Unmarshal(payloadRaw, &payload)
		}

		switch event {
		case "phase_started":
			p.status = "running"
		case "phase_completed":
			if status, ok := payload["status"].(string); ok {
				p.status = status
			} else {
				p.status = "completed"
			}
			if msg, ok := payload["message"].(string); ok && msg != "" {
				p.summary = msg
			}
		}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Build ordered phase snapshots
	result := make([]PhaseSnapshot, 0, len(phaseOrder))
	for _, phaseName := range phaseOrder {
		p := phases[phaseName]
		snap := PhaseSnapshot{
			Phase:      p.phase,
			Status:     p.status,
			StartedAt:  p.startedAt,
			EndedAt:    p.endedAt,
			EventCount: p.eventCount,
			Summary:    p.summary,
		}
		if p.lastEvent != "" {
			snap.LastEvent = &p.lastEvent
		}
		if p.startedAt != nil && p.endedAt != nil {
			dur := *p.endedAt - *p.startedAt
			snap.DurationMs = &dur
		}
		result = append(result, snap)
	}

	return &TimelineSnapshot{
		WorkspaceID: workspaceID,
		Phases:      result,
		LatestSeq:   latestSeq,
		TotalEvents: totalEvents,
		GeneratedAt: time.Now().UnixMilli(),
	}, nil
}
