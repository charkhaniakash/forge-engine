package repair

import (
	"testing"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation"
)

// fixableDiag builds an auto-fixable error diagnostic (the only kind the repair
// policy will hand to the agent).
func fixableDiag(stage, file, msg string) *models.ValidationDiagnostic {
	cat := validation.RepairCatAutoFixable
	return &models.ValidationDiagnostic{
		Stage:          stage,
		Severity:       "error",
		Category:       "code_error",
		FilePath:       &file,
		Message:        msg,
		RepairCategory: &cat,
	}
}

// TestPolicyEvaluateRetargetsRemainingFailure proves the fix for the repeated
// no-op repair loop: after a partial repair, the orchestrator re-runs
// policy.Evaluate(postRepairRun) to pick the diagnostics for the NEXT attempt.
// That set must be the CURRENT remaining failure (the test stage), not the
// original build errors an earlier attempt already resolved — otherwise the
// agent keeps "fixing" gone errors and writes a no-op (+0/-0) diff.
func TestPolicyEvaluateRetargetsRemainingFailure(t *testing.T) {
	p := NewRepairPolicy()

	// Trigger run: build fails with two auto-fixable diagnostics.
	trigger := run("failed_repairable",
		fixableDiag("build", "src/App.js", "'useEffect' is defined but never used"),
		fixableDiag("build", "src/App.js", "'searchData' is assigned but never used"),
	)
	td := p.Evaluate(trigger)
	if !td.Allowed || len(td.RepairableDiags) != 2 {
		t.Fatalf("trigger run: allowed=%v repairable=%d, want allowed with 2 build diags",
			td.Allowed, len(td.RepairableDiags))
	}

	// Post-repair run: the build errors are resolved; only a test failure remains.
	// This is exactly what o.policy.Evaluate(postRepairRun) sees in the "improved"
	// branch, and its RepairableDiags become the next attempt's currentDiags.
	postRepair := run("failed_repairable",
		fixableDiag("test", "", "test stage failed with exit code 1"),
	)
	pd := p.Evaluate(postRepair)
	if !pd.Allowed || len(pd.RepairableDiags) != 1 {
		t.Fatalf("post-repair run: allowed=%v repairable=%d, want allowed with 1 remaining diag",
			pd.Allowed, len(pd.RepairableDiags))
	}
	if got := pd.RepairableDiags[0].Stage; got != "test" {
		t.Errorf("re-target must hand the next attempt the remaining %q failure, got %q", "test", got)
	}
}

// TestPolicyEvaluateNoFixableRemaining proves the escalate-instead-of-spin guard:
// when the only remaining failure is NOT auto-fixable, re-evaluation yields an
// empty repairable set, so the loop escalates rather than launching another
// attempt that could only produce a no-op.
func TestPolicyEvaluateNoFixableRemaining(t *testing.T) {
	p := NewRepairPolicy()

	nonFixable := &models.ValidationDiagnostic{
		Stage:    "test",
		Severity: "error",
		Category: "code_error",
		Message:  "assertion failed",
		// RepairCategory nil → not auto-fixable.
	}
	postRepair := run("failed_repairable", nonFixable)

	pd := p.Evaluate(postRepair)
	if len(pd.RepairableDiags) != 0 {
		t.Errorf("non-fixable remaining failure must yield 0 repairable diags, got %d", len(pd.RepairableDiags))
	}
}
