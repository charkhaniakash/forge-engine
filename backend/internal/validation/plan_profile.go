package validation

import (
	"os"
	"strings"

	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
)

// plannerEnabled reports whether the repository-driven engine should DRIVE
// execution rather than only shadow-log. Off by default so the cutover is
// opt-in and instantly reversible via env (VALIDATION_PLANNER).
func plannerEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("VALIDATION_PLANNER"))) {
	case "1", "true", "on", "node":
		return true
	default:
		return false
	}
}

// planHasRunnable reports whether a plan has at least one Supported stage — i.e.
// there is something to execute. If not, the caller falls back to the legacy
// profile path.
func planHasRunnable(plan engine.ValidationPlan) bool {
	for _, u := range plan.Units {
		for _, s := range u.Stages {
			if s.State == engine.StateSupported {
				return true
			}
		}
	}
	return false
}
