package streaming

import (
	"sync"

	"go.uber.org/zap"
)

// AckManager tracks client acknowledgement state for gap detection and
// delivery confirmation. It works in tandem with the SessionManager's
// per-session AckedSeqs, providing higher-level gap analysis.
//
// The client periodically sends: {type: "ack", last_seq: {channel: seq}}
// The server uses this to determine:
//   - What the client has definitely received
//   - Whether there are gaps between delivered and acked
//   - Where to resume replay on reconnect
type AckManager struct {
	mu      sync.RWMutex
	// delivered tracks the last seq SENT to each session per channel.
	// This may be higher than the client's ack if events are in-flight.
	delivered map[string]map[string]int64 // sessionID → channel → last_delivered_seq
	logger    *zap.SugaredLogger
	metrics   *Metrics
}

// NewAckManager creates an acknowledgement manager.
func NewAckManager(logger *zap.SugaredLogger, metrics *Metrics) *AckManager {
	return &AckManager{
		delivered: make(map[string]map[string]int64),
		logger:    logger,
		metrics:   metrics,
	}
}

// RecordDelivered marks that an event with the given seq was sent to a session.
// Called by the Gateway's broadcast path after writing to the session's SendCh.
func (am *AckManager) RecordDelivered(sessionID, channel string, seq int64) {
	am.mu.Lock()
	chMap, ok := am.delivered[sessionID]
	if !ok {
		chMap = make(map[string]int64)
		am.delivered[sessionID] = chMap
	}
	if seq > chMap[channel] {
		chMap[channel] = seq
	}
	am.mu.Unlock()
}

// RecordDrop marks that an event was dropped for a session (backpressure).
func (am *AckManager) RecordDrop(sessionID, channel string, seq int64) {
	if am.metrics != nil {
		am.metrics.RecordDrop()
	}
	am.logger.Debugw("ack_event_dropped",
		"session_id", sessionID, "channel", channel, "seq", seq)
}

// GetDelivered returns the last delivered seq per channel for a session.
func (am *AckManager) GetDelivered(sessionID string) map[string]int64 {
	am.mu.RLock()
	chMap, ok := am.delivered[sessionID]
	if !ok {
		am.mu.RUnlock()
		return nil
	}
	result := make(map[string]int64, len(chMap))
	for ch, seq := range chMap {
		result[ch] = seq
	}
	am.mu.RUnlock()
	return result
}

// GapInfo describes a detected gap between what was delivered and what the client acked.
type GapInfo struct {
	Channel      string
	AckedSeq     int64
	DeliveredSeq int64
	GapSize      int64
}

// DetectGaps compares client acks against delivered sequences to find gaps.
// Gaps indicate events that were sent but not confirmed received by the client
// (likely lost due to transport issues or client-side drops).
func (am *AckManager) DetectGaps(sessionID string, clientAcks map[string]int64) []GapInfo {
	am.mu.RLock()
	chMap := am.delivered[sessionID]
	am.mu.RUnlock()

	if chMap == nil {
		return nil
	}

	var gaps []GapInfo
	for ch, deliveredSeq := range chMap {
		ackedSeq, hasAck := clientAcks[ch]
		if !hasAck {
			// Client hasn't acked this channel at all — could be a gap
			if deliveredSeq > 0 {
				gaps = append(gaps, GapInfo{
					Channel:      ch,
					AckedSeq:     0,
					DeliveredSeq: deliveredSeq,
					GapSize:      deliveredSeq,
				})
			}
			continue
		}
		if deliveredSeq > ackedSeq {
			gaps = append(gaps, GapInfo{
				Channel:      ch,
				AckedSeq:     ackedSeq,
				DeliveredSeq: deliveredSeq,
				GapSize:      deliveredSeq - ackedSeq,
			})
		}
	}
	return gaps
}

// RemoveSession cleans up all ack tracking state for a session.
func (am *AckManager) RemoveSession(sessionID string) {
	am.mu.Lock()
	delete(am.delivered, sessionID)
	am.mu.Unlock()
}
