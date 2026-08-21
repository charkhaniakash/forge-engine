package validation

import (
	"testing"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

func TestComputeOverallResult_NoTestsParserNoiseDoesNotFail(t *testing.T) {
	stages := []*models.ValidationStage{
		{Stage: "install", Status: "passed"},
		{Stage: "build", Status: "passed"},
		{Stage: "test", Status: "passed"}, // no_tests is persisted as passed
	}
	summary := &models.ValidationSummary{
		TotalErrors:  1, // leftover parser fallback from exit 1 / no test files
		BuildPassed:  true,
		TestsPassed:  true,
	}
	got := computeOverallResultWithOrigin(stages, summary, false)
	if got != "passed" {
		t.Fatalf("install+build+no_tests must be passed, got %s", got)
	}
}

func TestComputeOverallResult_FailedBuildIsRepairable(t *testing.T) {
	stages := []*models.ValidationStage{
		{Stage: "install", Status: "passed"},
		{Stage: "build", Status: "failed"},
	}
	summary := &models.ValidationSummary{TotalErrors: 1, BuildPassed: false}
	got := computeOverallResultWithOrigin(stages, summary, false)
	if got != "failed_repairable" {
		t.Fatalf("failed build must be failed_repairable, got %s", got)
	}
}
