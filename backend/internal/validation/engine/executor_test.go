package engine

import (
	"context"
	"testing"
)

// fakeRunner returns a scripted CommandResult per capability.
type fakeRunner struct {
	results map[Capability]CommandResult
	ran     []Capability
}

func (f *fakeRunner) Run(_ context.Context, _ string, stage StageSpec, _ OutputSink) CommandResult {
	f.ran = append(f.ran, stage.Capability)
	if r, ok := f.results[stage.Capability]; ok {
		return r
	}
	return CommandResult{ExitCode: 0}
}

// planWith builds a single-unit plan from explicit stages (bypassing providers).
func planWith(stages ...StageSpec) ValidationPlan {
	return ValidationPlan{Units: []UnitPlan{{Unit: Unit{Path: "."}, Stages: stages}}}
}

func supported(cap Capability, deps ...Capability) StageSpec {
	return StageSpec{Capability: cap, State: StateSupported, Command: []string{string(cap)}, DependsOn: deps}
}

func outcomeOf(res RunResult, cap Capability) Outcome {
	for _, s := range res.Units[0].Stages {
		if s.Capability == cap {
			return s.Outcome
		}
	}
	return ""
}

func TestExecute_HappyPath(t *testing.T) {
	plan := planWith(
		supported(CapInstall),
		supported(CapBuild, CapInstall),
		supported(CapTest, CapInstall, CapBuild),
	)
	res := Execute(context.Background(), plan, &fakeRunner{}, Options{})
	if res.Verdict != OutcomePassed {
		t.Fatalf("verdict=%s", res.Verdict)
	}
	if len(res.RepairSignals) != 0 {
		t.Fatalf("expected no repair signals, got %v", res.RepairSignals)
	}
}

func TestExecute_CodeFailureIsRepairable(t *testing.T) {
	plan := planWith(supported(CapInstall), supported(CapTest, CapInstall))
	runner := &fakeRunner{results: map[Capability]CommandResult{
		CapTest: {ExitCode: 1, Stdout: "FAIL src/x.test.js\nexpected 1 got 2"},
	}}
	res := Execute(context.Background(), plan, runner, Options{})
	if res.Verdict != OutcomeFailed {
		t.Fatalf("verdict=%s", res.Verdict)
	}
	if outcomeOf(res, CapTest) != OutcomeFailed {
		t.Fatalf("test outcome=%s", outcomeOf(res, CapTest))
	}
	if len(res.RepairSignals) != 1 || res.RepairSignals[0].Origin != OriginCode {
		t.Fatalf("expected 1 code signal, got %+v", res.RepairSignals)
	}
}

func TestExecute_TimeoutIsInfraNotCode(t *testing.T) {
	plan := planWith(supported(CapInstall), supported(CapTest, CapInstall))
	runner := &fakeRunner{results: map[Capability]CommandResult{
		CapTest: {TimedOut: true},
	}}
	res := Execute(context.Background(), plan, runner, Options{})
	if outcomeOf(res, CapTest) != OutcomeInfraError {
		t.Fatalf("timeout should be InfraError, got %s", outcomeOf(res, CapTest))
	}
	if res.Verdict != OutcomeInfraError {
		t.Fatalf("verdict=%s", res.Verdict)
	}
	if res.RepairSignals[0].Origin != OriginInfrastructure {
		t.Fatalf("origin=%s", res.RepairSignals[0].Origin)
	}
}

func TestExecute_NoTestsIsNotFailure(t *testing.T) {
	plan := planWith(supported(CapInstall), supported(CapTest, CapInstall))
	runner := &fakeRunner{results: map[Capability]CommandResult{
		CapTest: {ExitCode: 0, Stdout: "No tests found, exiting with code 0"},
	}}
	res := Execute(context.Background(), plan, runner, Options{})
	if outcomeOf(res, CapTest) != OutcomeNoTests {
		t.Fatalf("expected NoTests, got %s", outcomeOf(res, CapTest))
	}
	if res.Verdict != OutcomePassed {
		t.Fatalf("no-tests must not fail the verdict, got %s", res.Verdict)
	}
}

func TestExecute_MisconfiguredAndUnsupportedNeverRun(t *testing.T) {
	plan := planWith(
		supported(CapInstall),
		StageSpec{Capability: CapLint, State: StateMisconfigured, Reason: "eslint dep but no config", DependsOn: []Capability{CapInstall}},
		StageSpec{Capability: CapTypecheck, State: StateUnsupported, DependsOn: []Capability{CapInstall}},
	)
	runner := &fakeRunner{}
	res := Execute(context.Background(), plan, runner, Options{})

	if outcomeOf(res, CapLint) != OutcomeMisconfigured {
		t.Fatalf("lint=%s", outcomeOf(res, CapLint))
	}
	if outcomeOf(res, CapTypecheck) != OutcomeUnsupported {
		t.Fatalf("typecheck=%s", outcomeOf(res, CapTypecheck))
	}
	// Neither lint nor typecheck should have been executed.
	for _, c := range runner.ran {
		if c == CapLint || c == CapTypecheck {
			t.Fatalf("misconfigured/unsupported must not run, but %s ran", c)
		}
	}
	// Verdict must stay Passed — these are advisory, not failures.
	if res.Verdict != OutcomePassed {
		t.Fatalf("verdict=%s", res.Verdict)
	}
	// Misconfigured emits an advisory (config) signal; unsupported emits none.
	if len(res.RepairSignals) != 1 || res.RepairSignals[0].Origin != OriginConfiguration {
		t.Fatalf("expected 1 config signal, got %+v", res.RepairSignals)
	}
}

// Incremental: SkipBefore=build → install is Cached (not re-run) and, crucially,
// does NOT block build (cached counts as dependency-satisfied). This is the
// post-repair path.
func TestExecute_IncrementalCachedIsSatisfied(t *testing.T) {
	plan := planWith(
		supported(CapInstall),
		supported(CapBuild, CapInstall),
	)
	runner := &fakeRunner{}
	build := CapBuild
	res := Execute(context.Background(), plan, runner, Options{SkipBefore: &build})

	if outcomeOf(res, CapInstall) != OutcomeCached {
		t.Fatalf("install should be cached, got %s", outcomeOf(res, CapInstall))
	}
	for _, c := range runner.ran {
		if c == CapInstall {
			t.Fatal("cached install must not run")
		}
	}
	if outcomeOf(res, CapBuild) != OutcomePassed {
		t.Fatalf("build must run and pass despite cached install, got %s", outcomeOf(res, CapBuild))
	}
}

// recObserver records the lifecycle callbacks fired.
type recObserver struct {
	started, completed, skipped, output []Capability
}

func (r *recObserver) OnStageStart(s StageSpec) { r.started = append(r.started, s.Capability) }
func (r *recObserver) OnStageOutput(s StageSpec, _, _ string) {
	r.output = append(r.output, s.Capability)
}
func (r *recObserver) OnStageComplete(s StageSpec, _ StageResult) {
	r.completed = append(r.completed, s.Capability)
}
func (r *recObserver) OnStageSkipped(s StageSpec, _ StageResult) {
	r.skipped = append(r.skipped, s.Capability)
}

func TestExecute_ObserverCallbacks(t *testing.T) {
	plan := planWith(
		supported(CapInstall),
		StageSpec{Capability: CapLint, State: StateUnsupported},
		supported(CapTest, CapInstall),
	)
	obs := &recObserver{}
	Execute(context.Background(), plan, &fakeRunner{}, Options{Observer: obs})

	if len(obs.started) != 2 || obs.started[0] != CapInstall || obs.started[1] != CapTest {
		t.Fatalf("started=%v", obs.started)
	}
	if len(obs.completed) != 2 {
		t.Fatalf("completed=%v", obs.completed)
	}
	if len(obs.skipped) != 1 || obs.skipped[0] != CapLint {
		t.Fatalf("skipped=%v", obs.skipped)
	}
}

func TestExecute_CascadeSkipOnDependencyFailure(t *testing.T) {
	plan := planWith(
		supported(CapInstall),
		supported(CapBuild, CapInstall),
		supported(CapTest, CapInstall, CapBuild),
		supported(CapLint, CapInstall), // depends only on install → still runs
	)
	runner := &fakeRunner{results: map[Capability]CommandResult{
		CapBuild: {ExitCode: 2, Stderr: "build error"},
	}}
	res := Execute(context.Background(), plan, runner, Options{})

	if outcomeOf(res, CapBuild) != OutcomeFailed {
		t.Fatalf("build=%s", outcomeOf(res, CapBuild))
	}
	if outcomeOf(res, CapTest) != OutcomeSkipped {
		t.Fatalf("test should cascade-skip after build failure, got %s", outcomeOf(res, CapTest))
	}
	if outcomeOf(res, CapLint) != OutcomePassed {
		t.Fatalf("lint should still run (depends only on install), got %s", outcomeOf(res, CapLint))
	}
	for _, c := range runner.ran {
		if c == CapTest {
			t.Fatal("test must not run after build failure")
		}
	}
}
