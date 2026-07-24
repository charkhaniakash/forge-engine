package repair

import (
	"testing"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// diag builds a minimal error/warning diagnostic for a stage.
func diag(stage, severity, file, msg string, line int) *models.ValidationDiagnostic {
	return &models.ValidationDiagnostic{
		Stage:      stage,
		Severity:   severity,
		Tool:       "eslint",
		Category:   "code_error",
		FilePath:   &file,
		LineNumber: &line,
		Message:    msg,
	}
}

// run builds a ValidationRun with the given overall_result and diagnostics.
func run(overall string, diags ...*models.ValidationDiagnostic) *models.ValidationRun {
	var overallPtr *string
	if overall != "" {
		overallPtr = &overall
	}
	return &models.ValidationRun{
		OverallResult: overallPtr,
		Diagnostics:   diags,
	}
}

func TestCompareValidationOutcomes(t *testing.T) {
	o := &Orchestrator{}
	log := zap.NewNop().Sugar()

	tests := []struct {
		name   string
		before *models.ValidationRun
		after  *models.ValidationRun
		want   string
	}{
		{
			name: "build_fixed_lint_2_to_1_improved",
			before: run("failed_repairable",
				diag("build", "error", "src/a.js", "build failed", 1),
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
				diag("lint", "error", "src/b.js", "'useState' is not defined", 5),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/b.js", "'useState' is not defined", 5),
			),
			want: "improved",
		},
		{
			name: "build_fixed_lint_1_to_0_passed",
			before: run("failed_repairable",
				diag("build", "error", "src/a.js", "build failed", 1),
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
			),
			after: run("passed"),
			want:  "passed",
		},
		{
			name: "build_pass_to_fail_regressed",
			before: run("failed_repairable",
				diag("lint", "error", "src/a.js", "unused var", 3),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/a.js", "unused var", 3),
				diag("build", "error", "src/a.js", "syntax error", 10),
			),
			want: "regressed",
		},
		{
			name: "same_errors_no_change",
			before: run("failed_repairable",
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
			),
			want: "no_change",
		},
		{
			name: "same_error_shifted_line_no_change",
			before: run("failed_repairable",
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/a.js", "'axios' is not defined", 7),
			),
			want: "no_change",
		},
		{
			name: "structured_before_fallback_after_but_net_fewer_improved",
			before: run("failed_repairable",
				diag("build", "error", "src/a.js", "build failed", 1),
				diag("lint", "error", "src/a.js", "'axios' is not defined", 3),
				diag("lint", "error", "src/b.js", "'useState' is not defined", 5),
			),
			// Post-repair: build+test pass, only a generic fallback lint error
			// remains. Net errors 3 -> 1, lint already failed before, so improved
			// (NOT regressed just because the diagnostic identity changed).
			after: run("failed_repairable",
				diag("lint", "error", "", "lint stage failed with exit code 1", 0),
			),
			want: "improved",
		},
		{
			name: "more_errors_regressed",
			before: run("failed_repairable",
				diag("lint", "error", "src/a.js", "err one", 3),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/a.js", "err one", 3),
				diag("lint", "error", "src/a.js", "err two", 4),
			),
			want: "regressed",
		},
		{
			name:   "environment_failure_no_change",
			before: run("failed_repairable", diag("build", "error", "src/a.js", "x", 1)),
			after:  run("failed_environment"),
			want:   "no_change",
		},
		{
			name:   "requires_human_no_change",
			before: run("failed_repairable", diag("build", "error", "src/a.js", "x", 1)),
			after:  run("failed_requires_human"),
			want:   "no_change",
		},
		{
			name:   "nil_overall_error",
			before: run("failed_repairable", diag("build", "error", "src/a.js", "x", 1)),
			after:  run(""),
			want:   "error",
		},
		{
			name: "warnings_only_change_ignored_no_change",
			before: run("failed_repairable",
				diag("lint", "error", "src/a.js", "real error", 3),
			),
			after: run("failed_repairable",
				diag("lint", "error", "src/a.js", "real error", 3),
				diag("lint", "warning", "src/a.js", "some warning", 9),
			),
			want: "no_change", // warning added, error count unchanged, no new failing stage
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := o.compareValidationOutcomes(tt.before, tt.after, log)
			if got != tt.want {
				t.Errorf("compareValidationOutcomes() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCountErrorDiagnostics(t *testing.T) {
	diags := []*models.ValidationDiagnostic{
		diag("build", "error", "a", "e1", 1),
		diag("lint", "warning", "a", "w1", 2),
		diag("lint", "error", "b", "e2", 3),
		diag("lint", "info", "b", "i1", 4),
	}
	if got := countErrorDiagnostics(diags); got != 2 {
		t.Errorf("countErrorDiagnostics() = %d, want 2", got)
	}
}

// stg builds a minimal validation stage row carrying a status.
func stg(stage, status string) *models.ValidationStage {
	return &models.ValidationStage{Stage: stage, Status: status}
}

// TestCompareValidationOutcomes_SkippedStageIsNotRegression is the Bug 1 guard.
// In the trigger run the build FAILED, so `test` was SKIPPED (its dependency
// failed) and produced zero diagnostics. After the repair the build PASSES, so
// `test` finally runs — and fails. `test` must NOT be counted as "newly failing"
// because it never passed before; it was skipped. Without inspecting
// before.Stages the comparator cannot tell "skipped" from "passed", which is
// what previously produced a false "regressed" verdict and rolled back a good fix.
func TestCompareValidationOutcomes_SkippedStageIsNotRegression(t *testing.T) {
	o := &Orchestrator{}
	log := zap.NewNop().Sugar()

	before := run("failed_repairable",
		diag("build", "error", "src/App.js", "'useEffect' is defined but never used", 5),
		diag("build", "error", "src/App.js", "'searchData' is assigned but never used", 11),
	)
	before.Stages = []*models.ValidationStage{
		stg("install", "passed"),
		stg("build", "failed"),
		stg("test", "skipped"),
	}

	after := run("failed_repairable",
		diag("test", "error", "", "test stage failed with exit code 1", 0),
	)
	after.Stages = []*models.ValidationStage{
		stg("install", "passed"),
		stg("build", "passed"),
		stg("test", "failed"),
	}

	if got := o.compareValidationOutcomes(before, after, log); got != "improved" {
		t.Errorf("build fixed + previously-skipped test now failing must be %q, got %q", "improved", got)
	}
}

// TestCompareValidationOutcomes_PassedStageNowFailingIsRegression guards the
// opposite direction: a stage that genuinely PASSED before and fails now is a
// real regression even when the net error count is unchanged (the count-only
// path would say "no_change"). This proves the stage-status path is doing the
// work and that the Bug 1 fix did not over-correct into ignoring real regressions.
func TestCompareValidationOutcomes_PassedStageNowFailingIsRegression(t *testing.T) {
	o := &Orchestrator{}
	log := zap.NewNop().Sugar()

	before := run("failed_repairable",
		diag("lint", "error", "src/a.js", "unused var", 3),
	)
	before.Stages = []*models.ValidationStage{
		stg("build", "passed"),
		stg("lint", "failed"),
	}

	// Net error count stays at 1 (the lint error is replaced by a build error),
	// but build went passed -> failed.
	after := run("failed_repairable",
		diag("build", "error", "src/a.js", "syntax error", 10),
	)
	after.Stages = []*models.ValidationStage{
		stg("build", "failed"),
		stg("lint", "passed"),
	}

	if got := o.compareValidationOutcomes(before, after, log); got != "regressed" {
		t.Errorf("previously-passing build now failing must be %q, got %q", "regressed", got)
	}
}

func TestFailingStages(t *testing.T) {
	diags := []*models.ValidationDiagnostic{
		diag("build", "error", "a", "e1", 1),
		diag("lint", "warning", "a", "w1", 2), // warning-only should not mark lint failing
	}
	stages := failingStages(diags)
	if _, ok := stages["build"]; !ok {
		t.Error("expected build in failing stages")
	}
	if _, ok := stages["lint"]; ok {
		t.Error("lint has only a warning; should not be a failing stage")
	}
}
