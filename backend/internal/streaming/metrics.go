package streaming

import (
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Metrics collects streaming platform observability data.
// Phase 11C exposes these via a /metrics endpoint; for now they're
// periodically flushed to structured logs.
type Metrics struct {
	// Counters (monotonically increasing)
	EventsPersisted atomic.Int64
	EventsBroadcast atomic.Int64
	EventsDropped   atomic.Int64
	ReconnectCount  atomic.Int64

	// Gauges (point-in-time)
	activeConns sync.Map // workspaceID → int64

	// Histograms (sampled)
	replayDurations []time.Duration
	persistLatencies []time.Duration
	histMu          sync.Mutex

	logger *zap.SugaredLogger
}

// NewMetrics creates a new metrics collector.
func NewMetrics(logger *zap.SugaredLogger) *Metrics {
	return &Metrics{logger: logger}
}

// RecordPersist increments the persisted counter and records latency.
func (m *Metrics) RecordPersist(latency time.Duration) {
	m.EventsPersisted.Add(1)
	m.histMu.Lock()
	m.persistLatencies = append(m.persistLatencies, latency)
	// Keep only last 1000 samples
	if len(m.persistLatencies) > 1000 {
		m.persistLatencies = m.persistLatencies[len(m.persistLatencies)-1000:]
	}
	m.histMu.Unlock()
}

// RecordBroadcast increments the broadcast counter.
func (m *Metrics) RecordBroadcast() {
	m.EventsBroadcast.Add(1)
}

// RecordDrop increments the dropped event counter.
func (m *Metrics) RecordDrop() {
	m.EventsDropped.Add(1)
}

// RecordReconnect increments the reconnect counter.
func (m *Metrics) RecordReconnect() {
	m.ReconnectCount.Add(1)
}

// RecordReplay records a replay operation's duration.
func (m *Metrics) RecordReplay(duration time.Duration) {
	m.histMu.Lock()
	m.replayDurations = append(m.replayDurations, duration)
	if len(m.replayDurations) > 1000 {
		m.replayDurations = m.replayDurations[len(m.replayDurations)-1000:]
	}
	m.histMu.Unlock()
}

// SetActiveConnections updates the active connection gauge for a workspace.
func (m *Metrics) SetActiveConnections(workspaceID string, count int64) {
	if count <= 0 {
		m.activeConns.Delete(workspaceID)
	} else {
		m.activeConns.Store(workspaceID, count)
	}
}

// Snapshot returns a loggable summary of current metrics.
func (m *Metrics) Snapshot() map[string]interface{} {
	var totalConns int64
	m.activeConns.Range(func(_, val interface{}) bool {
		totalConns += val.(int64)
		return true
	})

	m.histMu.Lock()
	var avgPersistMs, avgReplayMs float64
	if len(m.persistLatencies) > 0 {
		var sum time.Duration
		for _, d := range m.persistLatencies {
			sum += d
		}
		avgPersistMs = float64(sum.Milliseconds()) / float64(len(m.persistLatencies))
	}
	if len(m.replayDurations) > 0 {
		var sum time.Duration
		for _, d := range m.replayDurations {
			sum += d
		}
		avgReplayMs = float64(sum.Milliseconds()) / float64(len(m.replayDurations))
	}
	m.histMu.Unlock()

	return map[string]interface{}{
		"events_persisted":     m.EventsPersisted.Load(),
		"events_broadcast":     m.EventsBroadcast.Load(),
		"events_dropped":       m.EventsDropped.Load(),
		"reconnect_count":      m.ReconnectCount.Load(),
		"active_connections":   totalConns,
		"avg_persist_ms":       avgPersistMs,
		"avg_replay_ms":        avgReplayMs,
	}
}

// LogSummary writes a periodic summary to structured logs.
// Call this from a ticker goroutine (e.g., every 60s).
func (m *Metrics) LogSummary() {
	snap := m.Snapshot()
	m.logger.Infow("streaming_metrics", snap)
}
