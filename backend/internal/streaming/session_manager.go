package streaming

import (
	"sync"
	"time"

	"go.uber.org/zap"
)

// SessionStatus represents the lifecycle state of a streaming session.
type SessionStatus string

const (
	SessionConnected    SessionStatus = "connected"
	SessionDisconnected SessionStatus = "disconnected"
)

// GracePeriod is the duration a disconnected session stays alive, preserving
// subscriptions and ack state. A reconnect within this window restores the
// session without a full replay (only gap-fill from last acked seq).
const GracePeriod = 5 * time.Minute

// CleanupInterval is how often the background goroutine evicts expired sessions.
const CleanupInterval = 60 * time.Second

// Session represents one browser tab's streaming connection state.
// It survives disconnects for GracePeriod, allowing seamless reconnection.
type Session struct {
	ID            string
	WorkspaceID   string
	UserID        string
	OrgID         string
	Subscriptions map[string]bool
	AckedSeqs     map[string]int64 // channel → last acked seq
	Status        SessionStatus
	SendCh        chan []byte
	CreatedAt     time.Time
	LastSeenAt    time.Time
	DisconnectedAt *time.Time
}

// IsExpired returns true if the session has been disconnected longer than GracePeriod.
func (s *Session) IsExpired() bool {
	if s.Status != SessionDisconnected || s.DisconnectedAt == nil {
		return false
	}
	return time.Since(*s.DisconnectedAt) > GracePeriod
}

// SessionManager manages streaming session lifecycle across connects,
// disconnects, and reconnects. It is the single authority on session identity.
//
// Thread-safe: all methods acquire appropriate locks.
type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session       // sessionID → session
	byWS     map[string][]string       // workspaceID → []sessionID
	logger   *zap.SugaredLogger
	metrics  *Metrics
}

// NewSessionManager creates a session manager.
func NewSessionManager(logger *zap.SugaredLogger, metrics *Metrics) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		byWS:     make(map[string][]string),
		logger:   logger,
		metrics:  metrics,
	}
}

// Create registers a new session for a workspace connection.
func (sm *SessionManager) Create(id, workspaceID, userID, orgID string, sendCh chan []byte, subscriptions []string) *Session {
	subs := make(map[string]bool, len(subscriptions))
	for _, ch := range subscriptions {
		subs[ch] = true
	}

	s := &Session{
		ID:            id,
		WorkspaceID:   workspaceID,
		UserID:        userID,
		OrgID:         orgID,
		Subscriptions: subs,
		AckedSeqs:     make(map[string]int64),
		Status:        SessionConnected,
		SendCh:        sendCh,
		CreatedAt:     time.Now(),
		LastSeenAt:    time.Now(),
	}

	sm.mu.Lock()
	sm.sessions[id] = s
	sm.byWS[workspaceID] = append(sm.byWS[workspaceID], id)
	sm.mu.Unlock()

	if sm.metrics != nil {
		sm.metrics.SetActiveConnections(workspaceID, int64(sm.CountForWorkspace(workspaceID)))
	}

	sm.logger.Debugw("session_created",
		"session_id", id, "workspace_id", workspaceID, "user_id", userID)
	return s
}

// Get returns a session by ID (nil if not found or expired).
func (sm *SessionManager) Get(sessionID string) *Session {
	sm.mu.RLock()
	s, ok := sm.sessions[sessionID]
	sm.mu.RUnlock()
	if !ok || s.IsExpired() {
		return nil
	}
	return s
}

// MarkDisconnected transitions a session to disconnected state.
// The session stays alive for GracePeriod to allow reconnection.
func (sm *SessionManager) MarkDisconnected(sessionID string) {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if ok {
		s.Status = SessionDisconnected
		now := time.Now()
		s.DisconnectedAt = &now
	}
	sm.mu.Unlock()

	if ok && sm.metrics != nil {
		sm.metrics.SetActiveConnections(s.WorkspaceID, int64(sm.countConnectedForWorkspace(s.WorkspaceID)))
	}

	sm.logger.Debugw("session_disconnected", "session_id", sessionID)
}

// Reconnect restores a disconnected session within its grace period.
// Returns the session if found and not expired, nil otherwise.
// On success, transitions back to connected with the new send channel.
func (sm *SessionManager) Reconnect(sessionID string, sendCh chan []byte) *Session {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if !ok || s.IsExpired() {
		sm.mu.Unlock()
		return nil
	}
	s.Status = SessionConnected
	s.SendCh = sendCh
	s.DisconnectedAt = nil
	s.LastSeenAt = time.Now()
	sm.mu.Unlock()

	if sm.metrics != nil {
		sm.metrics.RecordReconnect()
		sm.metrics.SetActiveConnections(s.WorkspaceID, int64(sm.countConnectedForWorkspace(s.WorkspaceID)))
	}

	sm.logger.Debugw("session_reconnected", "session_id", sessionID, "workspace_id", s.WorkspaceID)
	return s
}

// Remove permanently deletes a session (used when grace period expires).
func (sm *SessionManager) Remove(sessionID string) {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.Unlock()
		return
	}
	delete(sm.sessions, sessionID)
	// Remove from workspace index
	sids := sm.byWS[s.WorkspaceID]
	for i, sid := range sids {
		if sid == sessionID {
			sm.byWS[s.WorkspaceID] = append(sids[:i], sids[i+1:]...)
			break
		}
	}
	if len(sm.byWS[s.WorkspaceID]) == 0 {
		delete(sm.byWS, s.WorkspaceID)
	}
	sm.mu.Unlock()

	if sm.metrics != nil {
		sm.metrics.SetActiveConnections(s.WorkspaceID, int64(sm.countConnectedForWorkspace(s.WorkspaceID)))
	}
}

// Subscribe adds channels to a session's subscription set.
func (sm *SessionManager) Subscribe(sessionID string, channels []string) {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if ok {
		for _, ch := range channels {
			s.Subscriptions[ch] = true
		}
	}
	sm.mu.Unlock()
}

// Unsubscribe removes channels from a session's subscription set.
func (sm *SessionManager) Unsubscribe(sessionID string, channels []string) {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if ok {
		for _, ch := range channels {
			delete(s.Subscriptions, ch)
		}
	}
	sm.mu.Unlock()
}

// RecordAck updates the last acknowledged seq for a channel on a session.
func (sm *SessionManager) RecordAck(sessionID string, acks map[string]int64) {
	sm.mu.Lock()
	s, ok := sm.sessions[sessionID]
	if ok {
		for ch, seq := range acks {
			if seq > s.AckedSeqs[ch] {
				s.AckedSeqs[ch] = seq
			}
		}
		s.LastSeenAt = time.Now()
	}
	sm.mu.Unlock()
}

// GetAckedSeqs returns a copy of the session's acked sequences.
func (sm *SessionManager) GetAckedSeqs(sessionID string) map[string]int64 {
	sm.mu.RLock()
	s, ok := sm.sessions[sessionID]
	if !ok {
		sm.mu.RUnlock()
		return nil
	}
	result := make(map[string]int64, len(s.AckedSeqs))
	for ch, seq := range s.AckedSeqs {
		result[ch] = seq
	}
	sm.mu.RUnlock()
	return result
}

// Touch updates the LastSeenAt timestamp for a session.
func (sm *SessionManager) Touch(sessionID string) {
	sm.mu.Lock()
	if s, ok := sm.sessions[sessionID]; ok {
		s.LastSeenAt = time.Now()
	}
	sm.mu.Unlock()
}

// GetSessionsForWorkspace returns all connected sessions for a workspace.
func (sm *SessionManager) GetSessionsForWorkspace(workspaceID string) []*Session {
	sm.mu.RLock()
	sids := sm.byWS[workspaceID]
	result := make([]*Session, 0, len(sids))
	for _, sid := range sids {
		if s, ok := sm.sessions[sid]; ok && s.Status == SessionConnected {
			result = append(result, s)
		}
	}
	sm.mu.RUnlock()
	return result
}

// CountForWorkspace returns the total number of sessions (connected + disconnected within grace).
func (sm *SessionManager) CountForWorkspace(workspaceID string) int {
	sm.mu.RLock()
	count := len(sm.byWS[workspaceID])
	sm.mu.RUnlock()
	return count
}

// countConnectedForWorkspace returns connected sessions only (no lock — caller must hold lock or accept races).
func (sm *SessionManager) countConnectedForWorkspace(workspaceID string) int {
	sm.mu.RLock()
	count := 0
	for _, sid := range sm.byWS[workspaceID] {
		if s, ok := sm.sessions[sid]; ok && s.Status == SessionConnected {
			count++
		}
	}
	sm.mu.RUnlock()
	return count
}

// CleanupExpired removes all sessions that have exceeded the grace period.
// Called periodically by the background cleanup goroutine.
func (sm *SessionManager) CleanupExpired() int {
	sm.mu.Lock()
	var toRemove []string
	for id, s := range sm.sessions {
		if s.IsExpired() {
			toRemove = append(toRemove, id)
		}
	}
	for _, id := range toRemove {
		s := sm.sessions[id]
		delete(sm.sessions, id)
		sids := sm.byWS[s.WorkspaceID]
		for i, sid := range sids {
			if sid == id {
				sm.byWS[s.WorkspaceID] = append(sids[:i], sids[i+1:]...)
				break
			}
		}
		if len(sm.byWS[s.WorkspaceID]) == 0 {
			delete(sm.byWS, s.WorkspaceID)
		}
	}
	sm.mu.Unlock()

	if len(toRemove) > 0 {
		sm.logger.Infow("sessions_cleaned_up", "count", len(toRemove))
	}
	return len(toRemove)
}

// StartCleanupLoop runs the periodic session cleanup. Stops when ctx is done.
func (sm *SessionManager) StartCleanupLoop(done <-chan struct{}) {
	ticker := time.NewTicker(CleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			sm.CleanupExpired()
		}
	}
}
