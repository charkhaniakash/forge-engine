package repair

import (
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
)

// RepairDecision indicates whether autonomous repair is permitted for a
// validation run and provides the filtered list of auto-fixable diagnostics.
type RepairDecision struct {
	Allowed         bool
	RepairableDiags []*models.ValidationDiagnostic
	DenialReason    string // human-readable if !Allowed
}

// RepairPolicy decides whether autonomous repair is permitted for a given
// validation result. Today it only checks repair_category.
// Future extension points:
//   - Protected files (security policy)
//   - License constraints (open-source vs proprietary)
//   - Org-level repair policies
//   - Large refactor scope limits
type RepairPolicy struct{}

// NewRepairPolicy creates a new repair policy evaluator.
func NewRepairPolicy() *RepairPolicy {
	return &RepairPolicy{}
}

// Evaluate determines if repair should be attempted for the given validation run.
func (p *RepairPolicy) Evaluate(run *models.ValidationRun) RepairDecision {
	// Gate 1: only attempt repair on repairable results
	if run.OverallResult == nil || *run.OverallResult != "failed_repairable" {
		return RepairDecision{
			Allowed:      false,
			DenialReason: "validation result is not repairable",
		}
	}

	// Gate 2: must have at least one auto_fixable diagnostic
	var repairable []*models.ValidationDiagnostic
	for _, d := range run.Diagnostics {
		if d.RepairCategory != nil && *d.RepairCategory == "auto_fixable" {
			repairable = append(repairable, d)
		}
	}

	if len(repairable) == 0 {
		return RepairDecision{
			Allowed:      false,
			DenialReason: "no auto-fixable diagnostics found",
		}
	}

	// Gate 3: (future) check protected files
	// Gate 4: (future) check org policy
	// Gate 5: (future) check refactor scope limits

	return RepairDecision{
		Allowed:         true,
		RepairableDiags: repairable,
	}
}
