package validation

import (
	"testing"

	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
)

// Regression guard: engine diagnostics must map to the RepairCategory constants
// the RepairPolicy recognizes. In particular a CODE failure must be
// RepairCatAutoFixable, or repair Gate 2 (policy.go) rejects it and normal
// code/build/test failures silently become unrepairable.
func TestMapEngineDiagnostics_RepairCategories(t *testing.T) {
	cases := []struct {
		origin engine.FailureOrigin
		want   string
	}{
		{engine.OriginCode, RepairCatAutoFixable},
		{engine.OriginInfrastructure, RepairCatEnvironment},
		{engine.OriginTooling, RepairCatEnvironment},
		{engine.OriginConfiguration, RepairCatConfiguration},
	}
	for _, c := range cases {
		out := mapEngineDiagnostics([]engine.Diagnostic{{Severity: "error", Message: "x", Tool: "t"}}, c.origin)
		if len(out) != 1 {
			t.Fatalf("origin=%s: expected 1 diagnostic, got %d", c.origin, len(out))
		}
		if out[0].RepairCategory != c.want {
			t.Fatalf("origin=%s: RepairCategory=%q want %q", c.origin, out[0].RepairCategory, c.want)
		}
	}
}
