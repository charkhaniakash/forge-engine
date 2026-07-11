package execution

import (
	"fmt"
	"strings"
)

// ExecutionPolicy defines which tools are allowed for a given execution.
// Go evaluates this before every tool dispatch — the agent cannot self-escalate.
//
// Phase 7 policy: file read/write/create/delete/rename + list_dir + search_symbol.
// Phase 8 adds: shell (restricted to specific build/test commands).
// Phase 10 adds: git_* operations.
type ExecutionPolicy struct {
	// AllowedTools is the set of tool names the agent may call.
	AllowedTools map[string]bool
	// BlockedPathPrefixes prevents path-traversal outside /workspace.
	BlockedPathPrefixes []string
}

// Phase7Policy is the default policy for Phase 7 execution.
// Shell and git operations are explicitly blocked.
var Phase7Policy = ExecutionPolicy{
	AllowedTools: map[string]bool{
		"read_file":     true,
		"write_file":    true,
		"create_file":   true,
		"delete_file":   true,
		"rename_file":   true,
		"list_dir":      true,
		"search_symbol": true,
		"exists":        true,
		"stat":          true,
	},
	BlockedPathPrefixes: []string{
		"/etc", "/root", "/proc", "/sys", "/bin", "/sbin", "/usr/bin",
	},
}

// Validate checks that a tool call is permitted under this policy.
// Returns a structured error if the call is denied.
func (p ExecutionPolicy) Validate(tool, path string) error {
	if !p.AllowedTools[tool] {
		return fmt.Errorf("tool '%s' is not permitted in this execution policy", tool)
	}
	if path != "" {
		// All paths must be within /workspace.
		if !strings.HasPrefix(path, "/workspace") {
			return fmt.Errorf("path '%s' is outside /workspace — operation denied", path)
		}
		// Check explicitly blocked prefixes.
		for _, blocked := range p.BlockedPathPrefixes {
			if strings.HasPrefix(path, blocked) {
				return fmt.Errorf("path '%s' is in a blocked directory", path)
			}
		}
		// Prevent path traversal.
		if strings.Contains(path, "..") {
			return fmt.Errorf("path '%s' contains '..' — path traversal denied", path)
		}
	}
	return nil
}
