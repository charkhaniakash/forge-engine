package streaming

import "time"

// Envelope is the unified event format for all streaming communication.
// Every event persisted to stream_events and broadcast to clients uses this shape.
type Envelope struct {
	ID          string      `json:"id,omitempty"`
	WorkspaceID string      `json:"workspace_id,omitempty"` // omitted in WS messages (implicit)
	Channel     string      `json:"ch"`
	Event       string      `json:"ev"`
	Seq         int64       `json:"seq"`
	Ts          int64       `json:"ts"`
	Payload     interface{} `json:"payload,omitempty"`
	Phase       string      `json:"phase,omitempty"` // planning|executing|validation|repair|publishing|workspace|system
	SourceID    *string     `json:"-"`               // never serialized to client; DB traceability only
}

// NewEnvelope creates an envelope without seq/ts (assigned by EventStore).
func NewEnvelope(channel, event string, payload interface{}, phase string, sourceID *string) Envelope {
	return Envelope{
		Channel:  channel,
		Event:    event,
		Payload:  payload,
		Phase:    phase,
		SourceID: sourceID,
	}
}

// WithSeqAndTs stamps the envelope with ordering and timestamp.
func (e Envelope) WithSeqAndTs(seq int64, ts time.Time) Envelope {
	e.Seq = seq
	e.Ts = ts.UnixMilli()
	return e
}
