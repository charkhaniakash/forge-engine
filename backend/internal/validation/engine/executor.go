package engine

import "context"

// CommandResult is the raw outcome of running one stage command. The Runtime
// (a CommandRunner, wired over the workspace container in the validation
// package) produces these; the Classifier turns them into typed Outcomes.
type CommandResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
}

// CommandRunner executes a single Supported stage inside a unit and returns its
// raw result. It is the only side-effecting seam in execution — kept as an
// interface so the executor/classifier stay pure and unit-testable.
type CommandRunner interface {
	Run(ctx context.Context, unitPath string, stage StageSpec) CommandResult
}

// StageResult is the classified result of one capability.
type StageResult struct {
	Capability  Capability
	Outcome     Outcome
	Origin      FailureOrigin
	Command     []string
	Reason      string
	Diagnostics []Diagnostic
}

// UnitResult holds a unit's stage results.
type UnitResult struct {
	Unit   Unit
	Stages []StageResult
}

// RunResult is the full, classified result of executing a plan: per-unit stage
// outcomes, the aggregate verdict, and the structured signals the repair engine
// consumes (never raw output).
type RunResult struct {
	Units         []UnitResult
	Verdict       Outcome // Passed | Failed | InfraError (aggregate)
	RepairSignals []RepairSignal
}

// Execute runs a ValidationPlan through the runner and classifies every stage.
// Non-Supported capabilities are recorded without running (Unsupported/Skipped/
// Misconfigured); Supported capabilities run unless a dependency hard-failed,
// in which case they cascade to Skipped. Execution is deterministic given the
// plan and runner.
func Execute(ctx context.Context, plan ValidationPlan, runner CommandRunner) RunResult {
	result := RunResult{Verdict: OutcomePassed}

	for _, up := range plan.Units {
		ur := UnitResult{Unit: up.Unit}
		outcomes := make(map[Capability]Outcome, len(up.Stages))

		for _, stage := range up.Stages {
			sr := runOne(ctx, up.Unit, stage, outcomes, runner)
			outcomes[stage.Capability] = sr.Outcome
			ur.Stages = append(ur.Stages, sr)

			result.Verdict = worseVerdict(result.Verdict, sr.Outcome)
			if sig, ok := repairSignalFor(sr); ok {
				result.RepairSignals = append(result.RepairSignals, sig)
			}
		}
		result.Units = append(result.Units, ur)
	}
	return result
}

// runOne resolves the outcome for a single stage.
func runOne(ctx context.Context, unit Unit, stage StageSpec, done map[Capability]Outcome, runner CommandRunner) StageResult {
	// Non-Supported capabilities never run — their planning state maps directly
	// to an outcome the repair engine can trust.
	switch stage.State {
	case StateUnsupported:
		return StageResult{Capability: stage.Capability, Outcome: OutcomeUnsupported, Reason: stage.Reason}
	case StateSkipped:
		return StageResult{Capability: stage.Capability, Outcome: OutcomeSkipped, Reason: stage.Reason}
	case StateMisconfigured:
		return StageResult{Capability: stage.Capability, Outcome: OutcomeMisconfigured, Origin: OriginConfiguration, Reason: stage.Reason,
			Diagnostics: []Diagnostic{{Severity: "warning", Tool: stage.ProviderID, Message: stage.Reason}}}
	}

	// Cascade: skip if a dependency hard-failed (Failed / InfraError). An
	// Unsupported/Skipped/Passed/NoTests dependency does NOT block.
	if blockedBy, blocked := blockingDependency(stage, done); blocked {
		return StageResult{
			Capability: stage.Capability, Outcome: OutcomeSkipped,
			Reason: "skipped: dependency '" + string(blockedBy) + "' did not pass",
		}
	}

	res := runner.Run(ctx, unit.Path, stage)
	outcome, origin, diags := Classify(stage.Capability, res)
	return StageResult{
		Capability: stage.Capability, Outcome: outcome, Origin: origin,
		Command: stage.Command, Diagnostics: diags,
	}
}

// blockingDependency reports the first dependency that hard-failed.
func blockingDependency(stage StageSpec, done map[Capability]Outcome) (Capability, bool) {
	for _, dep := range stage.DependsOn {
		switch done[dep] {
		case OutcomeFailed, OutcomeInfraError:
			return dep, true
		}
	}
	return "", false
}

// worseVerdict folds a stage outcome into the aggregate verdict. Only
// InfraError and Failed downgrade the verdict; advisory outcomes never do.
func worseVerdict(current, stage Outcome) Outcome {
	rank := func(o Outcome) int {
		switch o {
		case OutcomeInfraError:
			return 2
		case OutcomeFailed:
			return 1
		default:
			return 0
		}
	}
	if rank(stage) > rank(current) {
		if stage == OutcomeInfraError {
			return OutcomeInfraError
		}
		return OutcomeFailed
	}
	return current
}

// repairSignalFor emits a signal only for outcomes the repair engine acts on or
// records. Passed / Unsupported / Skipped carry no signal.
func repairSignalFor(sr StageResult) (RepairSignal, bool) {
	switch sr.Outcome {
	case OutcomeFailed, OutcomeInfraError, OutcomeMisconfigured, OutcomeNoTests:
		return RepairSignal{
			Capability:  sr.Capability,
			Outcome:     sr.Outcome,
			Origin:      sr.Origin,
			Diagnostics: sr.Diagnostics,
		}, true
	default:
		return RepairSignal{}, false
	}
}
