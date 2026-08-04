package workspace

import (
	"os"
	"strconv"
)

// Config holds the default sandbox resource limits and image settings.
// All values are read from environment variables with safe defaults.
type Config struct {
	// SandboxImage is the Docker image used for all workspaces.
	SandboxImage string

	// Network is the Docker network workspace/validation containers attach to.
	// Defaults to the default "bridge" network. When the backend itself runs in
	// Docker (e.g. on a compose-defined network like "forge-network"), this MUST
	// match the backend's network — otherwise the preview proxy and validation
	// exec cannot reach the sandbox containers (cross-network isolation).
	Network string

	// Default resource limits — can be overridden per-workspace in future.
	DefaultCPULimit       string
	DefaultMemoryLimitMB  int
	DefaultPIDLimit       int
	DefaultTimeoutSeconds int

	// ReaperIntervalSeconds controls how often the orphan reaper runs.
	ReaperIntervalSeconds int
}

// DefaultConfig returns Config populated from environment variables.
func DefaultConfig() Config {
	return Config{
		SandboxImage:          getEnv("SANDBOX_IMAGE", "forge-sandbox-node:latest"),
		Network:               getEnv("SANDBOX_NETWORK", "bridge"),
		DefaultCPULimit:       getEnv("SANDBOX_CPU_LIMIT", "1.0"),
		DefaultMemoryLimitMB:  getEnvInt("SANDBOX_MEMORY_LIMIT_MB", 512),
		DefaultPIDLimit:       getEnvInt("SANDBOX_PID_LIMIT", 128),
		DefaultTimeoutSeconds: getEnvInt("SANDBOX_TIMEOUT_SECONDS", 1800),
		ReaperIntervalSeconds: getEnvInt("SANDBOX_REAPER_INTERVAL_SECONDS", 300),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}
