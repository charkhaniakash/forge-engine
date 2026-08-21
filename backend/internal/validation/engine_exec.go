package validation

import (
	"context"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/pipeline"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// runEngineStages delegates ALL execution semantics to engine.Execute (the
// single owner: ordering, incremental skip, dependency cascade, classification,
// pause/cancel checkpoints) and supplies the side-effects via three adapters:
//   - containerRunner: runs a stage in the validation container + streams output
//   - persistObserver: persists stage rows/diagnostics, publishes WS events, logs
//   - pauseAdapter:    bridges the pipeline pause/cancel signals
//
// It then maps the engine's RunResult onto the install/build/environment flags
// the existing result assembly consumes. There is no execution logic here — only
// I/O and mapping.
func (o *ValidationOrchestrator) runEngineStages(
	ctx context.Context,
	run *models.ValidationRun,
	plan engine.ValidationPlan,
	containerID string,
	opts *RunOpts,
	execID string,
	pauseChecker pipeline.PauseChecker,
	log *zap.SugaredLogger,
) (installPassed, buildPassed, hasEnvFailure bool) {
	installPassed, buildPassed = true, true

	var eopts engine.Options
	if opts != nil {
		eopts.SkipBefore = opts.SkipBefore
	}
	eopts.Observer = &persistObserver{
		o: o, ctx: ctx, run: run, log: log,
		stageIDs: map[engine.Capability]string{},
		buffers:  map[engine.Capability]*stageBuffers{},
	}
	if pauseChecker != nil && execID != "" {
		eopts.Pause = &pauseAdapter{o: o, run: run, pc: pauseChecker, execID: execID}
	}

	result := engine.Execute(ctx, plan, &containerRunner{o: o, containerID: containerID}, eopts)

	// Map outcomes → the flags the legacy result assembly expects.
	for _, u := range result.Units {
		for _, s := range u.Stages {
			hardFail := s.Outcome == engine.OutcomeFailed || s.Outcome == engine.OutcomeInfraError
			if s.Outcome == engine.OutcomeInfraError {
				hasEnvFailure = true
			}
			if s.Capability == engine.CapInstall && hardFail {
				installPassed = false
			}
			if s.Capability == engine.CapBuild && hardFail {
				buildPassed = false
			}
		}
	}

	if result.Cancelled || ctx.Err() != nil {
		markCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = o.repo.MarkCancelled(markCtx, run.ID)
		cancel()
		o.publish(run.ID, "validation_cancelled", map[string]interface{}{"reason": "context_cancelled"})
	}
	return
}

// ── CommandRunner adapter: executes a stage in the validation container ───────

type containerRunner struct {
	o           *ValidationOrchestrator
	containerID string
}

func (r *containerRunner) Run(
	ctx context.Context, unitPath string, stage engine.StageSpec, sink engine.OutputSink,
) engine.CommandResult {
	var stdoutB, stderrB strings.Builder
	exitCode := 0
	timedOut := false

	stageCtx, cancel := context.WithTimeout(ctx, time.Duration(stage.TimeoutSec+30)*time.Second)
	defer cancel()

	wd := dirOrDot(stage.WorkingDir)
	if unitPath != "" && unitPath != "." {
		wd = unitPath
	}

	ch, execErr := r.o.wsManager.ExecInValidationContainer(stageCtx, r.containerID, workspace.ExecRequest{
		Command:        stage.Command,
		WorkingDir:     wd,
		TimeoutSeconds: stage.TimeoutSec,
		Env:            stage.Env,
	})
	if execErr != nil {
		// Launch failure ≈ tool/infra problem; 127 routes to InfraError.
		return engine.CommandResult{ExitCode: 127, Stderr: execErr.Error()}
	}

	for ev := range ch {
		switch ev.Type {
		case "stdout":
			c := string(ev.Data)
			stdoutB.WriteString(c)
			sink.Write("stdout", c)
		case "stderr":
			c := string(ev.Data)
			stderrB.WriteString(c)
			sink.Write("stderr", c)
		case "exit":
			if ev.ExitCode != nil {
				exitCode = *ev.ExitCode
			}
		case "timeout":
			timedOut = true
		}
	}

	return engine.CommandResult{
		ExitCode: exitCode,
		Stdout:   stdoutB.String(),
		Stderr:   stderrB.String(),
		TimedOut: timedOut,
	}
}

// ── Observer adapter: persistence + WS events + structured logging ────────────

type stageBuffers struct {
	stdout, stderr, combined strings.Builder
}

type persistObserver struct {
	o        *ValidationOrchestrator
	ctx      context.Context
	run      *models.ValidationRun
	log      *zap.SugaredLogger
	seq      int
	stageIDs map[engine.Capability]string
	buffers  map[engine.Capability]*stageBuffers
}

func (p *persistObserver) buf(cap engine.Capability) *stageBuffers {
	b, ok := p.buffers[cap]
	if !ok {
		b = &stageBuffers{}
		p.buffers[cap] = b
	}
	return b
}

func (p *persistObserver) OnStageStart(stage engine.StageSpec) {
	p.seq++
	name := string(stage.Capability)
	row, err := p.o.repo.CreateStage(p.ctx, p.run.ID, name, p.seq, stage.Command)
	if err != nil || row == nil {
		p.log.Errorw("engine_create_stage_failed", "stage", name, "error", err)
		return
	}
	p.stageIDs[stage.Capability] = row.ID
	_ = p.o.repo.MarkStageRunning(p.ctx, row.ID)
	p.o.publish(p.run.ID, "stage_start", map[string]interface{}{
		"stage": name, "seq": p.seq, "command": stage.Command,
	})
	p.log.Infow("validation_stage_started", "stage", name, "command", stage.Command)
}

func (p *persistObserver) OnStageOutput(stage engine.StageSpec, stream, chunk string) {
	b := p.buf(stage.Capability)
	if stream == "stderr" {
		b.stderr.WriteString(chunk)
	} else {
		b.stdout.WriteString(chunk)
	}
	b.combined.WriteString(chunk)
	p.o.publish(p.run.ID, "stage_output", map[string]interface{}{
		"stage": string(stage.Capability), "chunk": chunk,
	})
}

func (p *persistObserver) OnStageComplete(stage engine.StageSpec, res engine.StageResult) {
	name := string(stage.Capability)
	stageID, ok := p.stageIDs[stage.Capability]
	if !ok {
		return // CreateStage failed earlier
	}
	passed := res.Outcome == engine.OutcomePassed || res.Outcome == engine.OutcomeNoTests
	b := p.buf(stage.Capability)
	_ = p.o.repo.CompleteStage(p.ctx, stageID, res.ExitCode,
		truncateStr(b.stdout.String(), 256*1024),
		truncateStr(b.stderr.String(), 256*1024),
		truncateStr(b.combined.String(), 512*1024),
		res.DurationMS, passed)

	// Try to get structured diagnostics from the agent parser — the engine's own
	// diagnostics carry no file_path, line_number, or column_number (classifier.go
	// produces bare {severity, tool, message} only). The parse-stage endpoint
	// extracts structured locations from the raw compiler/test output, giving the
	// repair pipeline the anchors it needs for evidence-based gather + fix.
	//
	// Design decisions:
	//   - Uses a detached context with a tight deadline (15s) so a slow or hung
	//     parser never delays stage completion events or blocks the pipeline.
	//   - Stamps the engine's RepairCategory routing onto parsed diagnostics
	//     (defense-in-depth: the parser may not set RepairCategory correctly for
	//     all tool outputs, and the engine's Origin classification is authoritative).
	//   - Falls back to the engine's bare diagnostics when the parser is
	//     unavailable, returns empty, or the context deadline expires.
	//   - OutcomeNoTests is advisory (react-scripts exits 1 with no test files).
	//     The stage is already marked passed — do NOT parse that output into
	//     error diagnostics or the overall run becomes failed_repairable and
	//     we skip publishing a green build.
	var diags []AgentDiagnostic
	needsParse := res.Outcome != engine.OutcomeNoTests &&
		(res.ExitCode != 0 || len(res.Diagnostics) > 0)
	if needsParse {
		parseCtx, parseCancel := context.WithTimeout(context.Background(), 15*time.Second)
		parseResp, parseErr := p.o.parseClient.ParseStage(parseCtx, ParseStageRequest{
			ValidationRunID: p.run.ID,
			Stage:           name,
			Stack:           p.run.Stack,
			ExitCode:        res.ExitCode,
			Stdout:          b.stdout.String(),
			Stderr:          b.stderr.String(),
			CombinedOutput:  b.combined.String(),
		})
		parseCancel()

		parseErrStr := "nil"
		if parseErr != nil {
			parseErrStr = parseErr.Error()
		}

		if parseErr == nil && parseResp != nil && len(parseResp.Diagnostics) > 0 {
			// Use the parser's rich diagnostics (with file paths, line numbers),
			// but override RepairCategory with the engine's authoritative Origin
			// classification so the repair policy sees the correct category.
			repair := repairCategoryForOrigin(res.Origin)
			diags = make([]AgentDiagnostic, len(parseResp.Diagnostics))
			for i, d := range parseResp.Diagnostics {
				diags[i] = d
				diags[i].RepairCategory = repair
			}
			p.log.Infow("engine_diagnostics_parsed",
				"stage", name, "count", len(diags),
				"source", "agent_parser")
		} else if len(res.Diagnostics) > 0 {
			// Fallback: use engine's bare diagnostics (no locations)
			diags = mapEngineDiagnostics(res.Diagnostics, res.Origin)
			p.log.Infow("engine_diagnostics_parsed",
				"stage", name, "count", len(diags),
				"source", "engine_fallback",
				"parse_error", parseErrStr)
		}
	}
	if len(diags) > 0 {
		_ = p.o.repo.InsertDiagnostics(p.ctx, p.run.ID, name, diags)
	}
	p.o.publish(p.run.ID, "stage_completed", map[string]interface{}{
		"stage": name, "exit_code": res.ExitCode, "stage_passed": passed, "outcome": string(res.Outcome),
	})
	p.log.Infow("validation_stage_completed",
		"stage", name, "outcome", string(res.Outcome), "exit_code", res.ExitCode,
		"passed", passed, "duration_ms", res.DurationMS)
}

func (p *persistObserver) OnStageSkipped(stage engine.StageSpec, res engine.StageResult) {
	p.seq++
	name := string(stage.Capability)
	row, _ := p.o.repo.CreateStage(p.ctx, p.run.ID, name, p.seq, nil)
	if row != nil {
		_ = p.o.repo.SkipStage(p.ctx, row.ID)
	}
	if res.Outcome == engine.OutcomeMisconfigured {
		_ = p.o.repo.InsertDiagnostics(p.ctx, p.run.ID, name, []AgentDiagnostic{{
			Severity: "warning", Category: "configuration", Message: res.Reason,
			Tool: "validation_planner", Origin: "planner", Confidence: 0.9, RepairCategory: RepairCatConfiguration,
		}})
	}
	p.o.publish(p.run.ID, "stage_skipped", map[string]interface{}{
		"stage": name, "outcome": string(res.Outcome), "reason": res.Reason,
	})
	if res.Outcome == engine.OutcomeCached {
		p.log.Infow("incremental_stage_cached", "stage", name, "reason", res.Reason)
	} else {
		p.log.Infow("validation_stage_skipped", "stage", name, "outcome", string(res.Outcome), "reason", res.Reason)
	}
}

// ── Pause adapter: bridges the pipeline pause/cancel signals ──────────────────

type pauseAdapter struct {
	o      *ValidationOrchestrator
	run    *models.ValidationRun
	pc     pipeline.PauseChecker
	execID string
}

func (a *pauseAdapter) WaitIfPaused(ctx context.Context) (cancelled bool) {
	if a.pc.IsCancelled(ctx, a.execID) {
		return true
	}
	if a.pc.IsPaused(ctx, a.execID) {
		a.o.publish(a.run.ID, "validation_paused", map[string]interface{}{})
		if a.pc.WaitForResume(ctx, a.execID) {
			return true
		}
		a.o.publish(a.run.ID, "validation_resumed", map[string]interface{}{})
	}
	return false
}

// mapEngineDiagnostics converts engine diagnostics to the persisted
// AgentDiagnostic shape, routing the repair category by failure origin.
// repairCategoryForOrigin returns the RepairCategory string that should be used
// for diagnostics whose failure origin is the given engine origin.
// This is the single source of truth for the mapping — both mapEngineDiagnostics
// and the parse-stage integration call this so they stay in sync.
func repairCategoryForOrigin(origin engine.FailureOrigin) string {
	switch origin {
	case engine.OriginInfrastructure, engine.OriginTooling:
		return RepairCatEnvironment
	case engine.OriginConfiguration:
		return RepairCatConfiguration
	default:
		return RepairCatAutoFixable
	}
}

func mapEngineDiagnostics(diags []engine.Diagnostic, origin engine.FailureOrigin) []AgentDiagnostic {
	category := "code_error"
	switch origin {
	case engine.OriginInfrastructure, engine.OriginTooling:
		category = "environment_error"
	case engine.OriginConfiguration:
		category = "configuration"
	}
	repair := repairCategoryForOrigin(origin)
	out := make([]AgentDiagnostic, 0, len(diags))
	for _, d := range diags {
		sev := d.Severity
		if sev == "" {
			sev = "error"
		}
		out = append(out, AgentDiagnostic{
			Severity: sev, Category: category, FilePath: d.File, LineNumber: d.Line, ColumnNumber: d.Column,
			Message: d.Message, Tool: d.Tool, Origin: "planner", Confidence: 0.9, RepairCategory: repair,
		})
	}
	return out
}

func dirOrDot(p string) string {
	if strings.TrimSpace(p) == "" {
		return "."
	}
	return p
}
