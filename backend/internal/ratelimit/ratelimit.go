package ratelimit

import (
    "time"
)

// Config represents rate limit configuration
type Config struct {
    // AuthAttempts: max login attempts per IP per hour
    AuthAttempts int
    AuthWindow   time.Duration

    // SignupAttempts: max signups per IP per hour
    SignupAttempts int
    SignupWindow   time.Duration

    // APIRequests: max API requests per user per minute
    APIRequests int
    APIWindow   time.Duration
}

// DefaultConfig returns sensible Phase 1 defaults
func DefaultConfig() Config {
    return Config{
        AuthAttempts:   5,
        AuthWindow:     1 * time.Hour,
        SignupAttempts: 3,
        SignupWindow:   1 * time.Hour,
        APIRequests:    100,
        APIWindow:      1 * time.Minute,
    }
}

// Limiter is a token bucket rate limiter (stub for Phase 1)
// Real implementation in Phase 6+ will store state in Redis
type Limiter struct {
    config Config
}

func NewLimiter(config Config) *Limiter {
    return &Limiter{config: config}
}

// IsAuthAllowed checks if auth attempt is allowed (stub)
func (l *Limiter) IsAuthAllowed(ip string) bool {
    // TODO: Phase 6 — implement with Redis
    return true
}

// IsSignupAllowed checks if signup is allowed (stub)
func (l *Limiter) IsSignupAllowed(ip string) bool {
    // TODO: Phase 6 — implement with Redis
    return true
}

// IsAPIAllowed checks if API request is allowed (stub)
func (l *Limiter) IsAPIAllowed(userID string) bool {
    // TODO: Phase 6 — implement with Redis
    return true
}