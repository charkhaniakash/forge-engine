package streaming

import "time"

// Connection lifecycle constants.
const (
	// PongTimeout is how long after sending a ping we wait for a pong before
	// declaring the connection dead.
	PongTimeout = 30 * time.Second

	// IdleTimeout is how long without any client message before we consider
	// the client gone and unregister the session.
	IdleTimeout = 5 * time.Minute

	// PingInterval is how often we send pings to detect dead connections.
	ConnPingInterval = 20 * time.Second

	// SendBufferSize is the capacity of the per-session send channel.
	SendBufferSize = 512
)

// ConnectionCallbacks defines the lifecycle hooks for a managed connection.
// Implemented by the Gateway to react to connection events.
type ConnectionCallbacks interface {
	OnConnect(sessionID string)
	OnDisconnect(sessionID string)
	OnMessage(sessionID string, msg []byte)
}

// ConnectionState tracks the health of a single WebSocket connection.
// Used by the Gateway's write/read pumps to enforce timeouts.
type ConnectionState struct {
	SessionID    string
	LastPingSent time.Time
	LastPongAt   time.Time
	LastMsgAt    time.Time
}

// NewConnectionState creates a fresh connection state.
func NewConnectionState(sessionID string) *ConnectionState {
	now := time.Now()
	return &ConnectionState{
		SessionID: sessionID,
		LastPongAt: now,
		LastMsgAt:  now,
	}
}

// IsPongOverdue returns true if a ping was sent but no pong received within PongTimeout.
func (cs *ConnectionState) IsPongOverdue() bool {
	if cs.LastPingSent.IsZero() {
		return false
	}
	return cs.LastPingSent.After(cs.LastPongAt) && time.Since(cs.LastPingSent) > PongTimeout
}

// IsIdle returns true if no client message has been received within IdleTimeout.
func (cs *ConnectionState) IsIdle() bool {
	return time.Since(cs.LastMsgAt) > IdleTimeout
}

// RecordPing marks that a ping was just sent.
func (cs *ConnectionState) RecordPing() {
	cs.LastPingSent = time.Now()
}

// RecordPong marks that a pong was received.
func (cs *ConnectionState) RecordPong() {
	cs.LastPongAt = time.Now()
}

// RecordMessage marks that a client message was received.
func (cs *ConnectionState) RecordMessage() {
	cs.LastMsgAt = time.Now()
}
