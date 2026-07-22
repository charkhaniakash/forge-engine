package engine

import (
	"context"
	"time"
)

// CommandResult is the raw outcome of running one stage command. The Runtime
// (a CommandRunner, wired over the workspace container in the validation
// package) produces these; the Classifier turns them into typed Outcomes.
type CommandResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	TimedOut bool
}

// OutputSink receives command output live, as it is produced, so the caller can
// stream it (e.g. to a UI) while the command is still running. stream is
// "stdout" or "stderr".
type OutputSink interface {
	Write(stream, chunk string)
}

// CommandRunner executes a single Supported stage inside a unit and returns its
// raw result, writing output to sink as it arrives. It is the only
// side-effecting seam in execution — kept as an interface so the executor and
// classifier stay pure and unit-testable.
type CommandRunner interface {
	Run(ctx context.Context, unitPath string, stage StageSpec, sink OutputSink) CommandResult
}

// Observer receives stage lifecycle callbacks so a caller can persist rows,
// publish events, and log — WITHOUT owning any execution semantics. All methods
// are optional in spirit (a nil Observer becomes a no-op). Observers must not
// influence outcomes; the engine decides those.
type Observer interface {
	OnStageStart(stage StageSpec)
	OnStageOutput(stage StageSpec, stream, chunk string)
	OnStageComplete(stage StageSpec, result StageResult)
	OnStageSkipped(stage StageSpec, result StageResult)
}

// PauseController is consulted at stage boundaries. WaitIfPaused blocks while the
// run is paused and returns true if it was cancelled (the engine then stops).
// This keeps the pause *checkpoints* in the engine and the pause *mechanism* in
// the caller.
type PauseController interface {
	WaitIfPaused(ctx context.Context) (cancelled bool)
}

// Options carries the optional collaborators + incremental hints for a run. A
// zero Options runs the plan as a pure batch (no streaming/persistence/pause),
// which is exactly what the unit tests exercise.
type Options struct {
	Observer   Observer
	Pause      PauseController
	SkipBefore *Capability // stages strictly before this are cached, not re-run
}

// StageResult is the classified result of one capability, plus the raw scalars a
// caller needs to persist it. Text output is streamed via the Observer, not
// carried here.
type StageResult struct {
	Capability  Capability
	Outcome     Outcome
	Origin      FailureOrigin
	Command     []string
	Reason      string
	ExitCode    int
	DurationMS  int
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
	Cancelled     bool // execution stopped early due to cancel/pause-cancel
}

// Execute runs a ValidationPlan and is THE single owner of execution semantics:
// stage ordering, incremental skip, dependency cascade, classification, verdict
// aggregation, repair-signal emission, and pause/cancel checkpoints. All
// side-effects (running commands, streaming, persistence, pause mechanism) are
// injected via runner + opts, so this function is pure and deterministic given
// them.
func Execute(ctx context.Context, plan ValidationPlan, runner CommandRunner, opts Options) RunResult {
	obs := opts.Observer
	if obs == nil {
		obs = nopObserver{}
	}
	result := RunResult{Verdict: OutcomePassed}

	for _, up := range plan.Units {
		ur := UnitResult{Unit: up.Unit}
		outcomes := make(map[Capability]Outcome, len(up.Stages))

		for _, stage := range up.Stages {
			sr := resolveStage(ctx, up.Unit, stage, outcomes, runner, obs, opts)
			outcomes[stage.Capability] = sr.Outcome
			ur.Stages = append(ur.Stages, sr)

			result.Verdict = worseVerdict(result.Verdict, sr.Outcome)
			if sig, ok := repairSignalFor(sr); ok {
				result.RepairSignals = append(result.RepairSignals, sig)
			}

			// Boundary checkpoint: pause (blocks) then cancel.
			if opts.Pause != nil && opts.Pause.WaitIfPaused(ctx) {
				result.Cancelled = true
			}
			if result.Cancelled || ctx.Err() != nil {
				result.Cancelled = true
				result.Units = append(result.Units, ur)
				return result
			}
		}
		result.Units = append(result.Units, ur)
	}
	return result
}

// resolveStage produces the StageResult for one stage, invoking the runner +
// observer as appropriate. It never mutates shared state beyond returning.
func resolveStage(
	ctx context.Context, unit Unit, stage StageSpec,
	done map[Capability]Outcome, runner CommandRunner, obs Observer, opts Options,
) StageResult {
	// Incremental: stages before the threshold are cached (previous result reused).
	if opts.SkipBefore != nil && capIndex(stage.Capability) < capIndex(*opts.SkipBefore) {
		sr := StageResult{Capability: stage.Capability, Outcome: OutcomeCached,
			Reason: "cached: unaffected by change — previous result reused"}
		obs.OnStageSkipped(stage, sr)
		return sr
	}

	// Non-Supported capabilities never run — planning state maps to an outcome.
	switch stage.State {
	case StateUnsupported:
		sr := StageResult{Capability: stage.Capability, Outcome: OutcomeUnsupported, Reason: stage.Reason}
		obs.OnStageSkipped(stage, sr)
		return sr
	case StateSkipped:
		sr := StageResult{Capability: stage.Capability, Outcome: OutcomeSkipped, Reason: stage.Reason}
		obs.OnStageSkipped(stage, sr)
		return sr
	case StateMisconfigured:
		sr := StageResult{Capability: stage.Capability, Outcome: OutcomeMisconfigured, Origin: OriginConfiguration,
			Reason: stage.Reason, Diagnostics: []Diagnostic{{Severity: "warning", Tool: stage.ProviderID, Message: stage.Reason}}}
		obs.OnStageSkipped(stage, sr)
		return sr
	}

	// Cascade: skip when a dependency hard-failed. Cached/Passed/etc. don't block.
	if dep, blocked := blockingDependency(stage, done); blocked {
		sr := StageResult{Capability: stage.Capability, Outcome: OutcomeSkipped,
			Reason: "skipped: dependency '" + string(dep) + "' did not pass"}
		obs.OnStageSkipped(stage, sr)
		return sr
	}

	// Execute.
	obs.OnStageStart(stage)
	start := time.Now()
	res := runner.Run(ctx, unit.Path, stage, stageSink{obs: obs, stage: stage})
	durationMS := int(time.Since(start).Milliseconds())

	outcome, origin, diags := Classify(stage.Capability, res)
	sr := StageResult{
		Capability: stage.Capability, Outcome: outcome, Origin: origin,
		Command: stage.Command, ExitCode: res.ExitCode, DurationMS: durationMS, Diagnostics: diags,
	}
	obs.OnStageComplete(stage, sr)
	return sr
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

// capIndex returns the pipeline position of a capability (for incremental skip).
func capIndex(c Capability) int {
	for i, x := range capabilityOrder {
		if x == c {
			return i
		}
	}
	return len(capabilityOrder)
}

// worseVerdict folds a stage outcome into the aggregate verdict. Only InfraError
// and Failed downgrade the verdict; advisory outcomes never do.
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
// records. Passed / Cached / Unsupported / Skipped carry no signal.
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

// stageSink adapts the Observer to the OutputSink the runner writes to.
type stageSink struct {
	obs   Observer
	stage StageSpec
}

func (s stageSink) Write(stream, chunk string) { s.obs.OnStageOutput(s.stage, stream, chunk) }

// nopObserver is used when no Observer is supplied (pure batch execution).
type nopObserver struct{}

func (nopObserver) OnStageStart(StageSpec)                  {}
func (nopObserver) OnStageOutput(StageSpec, string, string) {}
func (nopObserver) OnStageComplete(StageSpec, StageResult)  {}
func (nopObserver) OnStageSkipped(StageSpec, StageResult)   {}
