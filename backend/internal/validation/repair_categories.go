package validation

// Repair category constants — the only valid values for RepairCategory on
// diagnostics. These determine whether the repair engine will attempt
// autonomous code fixes.
//
// Contract:
//   - RepairPolicy.Evaluate() gates on RepairCatAutoFixable
//   - computeSummary counts AutoFixableCount and NeedsHumanCount
//   - computeOverallResultWithOrigin uses NeedsHumanCount for routing
//
// Adding a new value here requires updating:
//   1. RepairPolicy.Evaluate() in repair/policy.go
//   2. computeSummary() in repository.go
//   3. The Python agent's validation/models.py
const (
	// RepairCatAutoFixable — the AI repair agent can fix this autonomously.
	// Used for code-level failures (compile errors, lint violations, test failures).
	RepairCatAutoFixable = "auto_fixable"

	// RepairCatNeedsHuman — requires human intervention. The repair agent will
	// not attempt to fix these. Examples: test panics, security issues.
	RepairCatNeedsHuman = "needs_human"

	// RepairCatEnvironment — infrastructure/environment problem. Not a code issue.
	// Examples: network failure, disk full, tool missing from container.
	RepairCatEnvironment = "environment_limitation"

	// RepairCatConfiguration — tool configuration problem (e.g. missing eslintrc).
	// Distinct from code errors — may require human review of config files.
	RepairCatConfiguration = "configuration"

	// RepairCatUnknown — cannot classify. Treated as non-repairable by default.
	RepairCatUnknown = "unknown"
)
