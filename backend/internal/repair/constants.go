package repair

// Repair configuration defaults.
// These are used when no org-level configuration overrides them.
const (
	DefaultMaxAttempts     = 3
	DefaultMaxDurationSecs = 1800 // 30 minutes
	DefaultAgentTokenTTL   = 300  // 5 minutes
	DefaultAgentVersion    = "repair_graph_v1"
	DefaultModel           = "gemini-2.0-flash-exp"
	DefaultTemperature     = 0.1
	DefaultMaxTokens       = 4096
)
