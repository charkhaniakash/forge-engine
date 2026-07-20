package streaming

import (
	"context"
	"encoding/json"
	"time"

	"go.uber.org/zap"
)

// ReplayEngine coordinates event replay from the in-memory ReplayBuffer or the
// durable EventStore. It is the single point of replay logic for all session
// recovery scenarios: fresh connect, reconnect, and server restart.
//
// Strategy:
//  1. Check if ReplayBuffer can serve the full range (afterSeq → latest)
//  2. If yes: stream from memory (fast path, no DB query)
//  3. If no: fall back to EventStore.ReplayFrom (DB query)
//
// The engine rate-limits replay output to avoid flooding a reconnecting client.
type ReplayEngine struct {
	buffer *ReplayBuffer
	store  *EventStore
	logger *zap.SugaredLogger

	// replayBatchSize is the number of events sent per batch during replay.
	replayBatchSize int
	// replayBatchPause is the pause between batches during replay.
	replayBatchPause time.Duration
}

// NewReplayEngine creates a replay engine.
func NewReplayEngine(buffer *ReplayBuffer, store *EventStore, logger *zap.SugaredLogger) *ReplayEngine {
	return &ReplayEngine{
		buffer:           buffer,
		store:            store,
		logger:           logger,
		replayBatchSize:  50,
		replayBatchPause: time.Millisecond,
	}
}

// ReplayTarget defines where replayed events are sent.
// This abstracts the session's send channel so the engine doesn't depend on
// the gateway or websocket packages directly.
type ReplayTarget interface {
	// SendEnvelope sends a single envelope to the target.
	// Returns false if the target is closed/full (stop replaying).
	SendEnvelope(env Envelope) bool
	// Subscriptions returns the channels this target is subscribed to.
	Subscriptions() map[string]bool
}

// ReplayFull replays the complete event history for a workspace to a target.
// Used for fresh browser connections that have no prior state.
// Filters by the target's subscribed channels.
func (re *ReplayEngine) ReplayFull(ctx context.Context, workspaceID string, target ReplayTarget) error {
	return re.replayFromSeq(ctx, workspaceID, 0, target)
}

// Replay resumes streaming from the last acknowledged sequences per channel.
// Used for browser reconnection within or after the grace period.
//
// afterSeqs maps channel → last_seq_seen. Events with seq > afterSeqs[ch] are sent.
// If afterSeqs is empty, behaves like ReplayFull.
func (re *ReplayEngine) Replay(ctx context.Context, workspaceID string, afterSeqs map[string]int64, target ReplayTarget) error {
	if len(afterSeqs) == 0 {
		return re.ReplayFull(ctx, workspaceID, target)
	}

	// Find the minimum seq across all channels — that's our replay starting point.
	// We'll filter per-channel below.
	var minSeq int64
	first := true
	for _, seq := range afterSeqs {
		if first || seq < minSeq {
			minSeq = seq
			first = false
		}
	}

	subs := target.Subscriptions()
	envs, err := re.fetchFrom(ctx, workspaceID, minSeq, subs)
	if err != nil {
		return err
	}

	// Filter: only send events that are newer than the target's per-channel ack.
	sent := 0
	batchTicker := time.NewTicker(re.replayBatchPause)
	defer batchTicker.Stop()

	for _, env := range envs {
		if !subs[env.Channel] {
			continue
		}
		acked, hasAck := afterSeqs[env.Channel]
		if hasAck && env.Seq <= acked {
			continue
		}

		if !target.SendEnvelope(env) {
			re.logger.Debugw("replay_target_full_stopping",
				"workspace_id", workspaceID, "sent", sent)
			break
		}
		sent++

		// Rate-limit to avoid flooding
		if sent%re.replayBatchSize == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-batchTicker.C:
			}
		}
	}

	re.logger.Debugw("replay_complete",
		"workspace_id", workspaceID, "events_sent", sent, "from_seq", minSeq)
	return nil
}

// replayFromSeq fetches events after the given seq and streams them to target.
func (re *ReplayEngine) replayFromSeq(ctx context.Context, workspaceID string, afterSeq int64, target ReplayTarget) error {
	subs := target.Subscriptions()
	envs, err := re.fetchFrom(ctx, workspaceID, afterSeq, subs)
	if err != nil {
		return err
	}

	sent := 0
	batchTicker := time.NewTicker(re.replayBatchPause)
	defer batchTicker.Stop()

	for _, env := range envs {
		if !subs[env.Channel] {
			continue
		}
		if !target.SendEnvelope(env) {
			break
		}
		sent++

		if sent%re.replayBatchSize == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-batchTicker.C:
			}
		}
	}

	re.logger.Debugw("replay_from_seq_complete",
		"workspace_id", workspaceID, "after_seq", afterSeq, "events_sent", sent)
	return nil
}

// fetchFrom tries the in-memory buffer first, falls back to DB.
func (re *ReplayEngine) fetchFrom(ctx context.Context, workspaceID string, afterSeq int64, channels map[string]bool) ([]Envelope, error) {
	// Fast path: try memory buffer
	envs, ok := re.buffer.GetFiltered(workspaceID, afterSeq, channels)
	if ok {
		re.logger.Debugw("replay_served_from_buffer",
			"workspace_id", workspaceID, "after_seq", afterSeq, "count", len(envs))
		return envs, nil
	}

	// Slow path: query DB
	re.logger.Debugw("replay_falling_back_to_db",
		"workspace_id", workspaceID, "after_seq", afterSeq,
		"buffer_oldest", re.buffer.OldestSeq(workspaceID))

	var channelList []string
	if len(channels) > 0 {
		channelList = make([]string, 0, len(channels))
		for ch := range channels {
			channelList = append(channelList, ch)
		}
	}

	return re.store.ReplayFrom(ctx, workspaceID, afterSeq, channelList, 2000)
}

// ── Convenience: adapt a raw send channel to ReplayTarget ───────────────────

// ChannelTarget adapts a raw `chan []byte` + subscription map into a ReplayTarget.
// Used by the Gateway to replay into existing BrowserSession send channels.
type ChannelTarget struct {
	sendCh        chan []byte
	subscriptions map[string]bool
}

// NewChannelTarget creates a ReplayTarget backed by a byte channel.
func NewChannelTarget(sendCh chan []byte, subscriptions map[string]bool) *ChannelTarget {
	return &ChannelTarget{sendCh: sendCh, subscriptions: subscriptions}
}

func (ct *ChannelTarget) SendEnvelope(env Envelope) bool {
	raw, err := json.Marshal(env)
	if err != nil {
		return false
	}
	select {
	case ct.sendCh <- raw:
		return true
	default:
		return false // channel full — stop replay
	}
}

func (ct *ChannelTarget) Subscriptions() map[string]bool {
	return ct.subscriptions
}
