package validation

import (
	"context"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation/engine"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// runEngineStages executes a repository-driven ValidationPlan inside the
// validation container, classifies each stage with the engine's 7-state
// taxonomy, and PERSISTS results in the same shape the legacy loop produces
// (stage rows + diagnostics + install/build/env flags). That lets the existing
// result assembly and the repair engine consume it unchanged. Returns the flags
// the overall-result computation needs.
func (o *ValidationOrchestrator) runEngineStages(
	ctx context.Context,
	run *models.ValidationRun,
	plan engine.ValidationPlan,
	containerID string,
	log *zap.SugaredLogger,
) (installPassed, buildPassed, hasEnvFailure bool) {
	installPassed, buildPassed = true, true
	if len(plan.Units) == 0 {
		return
	}

	outcomes := map[engine.Capability]engine.Outcome{}
	seq := 0
	for _, stage := range plan.Units[0].Stages {
		seq++
		capName := string(stage.Capability)

		// Non-Supported capabilities never run — record them and move on.
		switch stage.State {
		case engine.StateUnsupported:
			outcomes[stage.Capability] = engine.OutcomeUnsupported
			continue
		case engine.StateSkipped:
			outcomes[stage.Capability] = engine.OutcomeSkipped
			o.skipEngineStage(ctx, run.ID, capName, seq, "skipped: "+stage.Reason)
			continue
		case engine.StateMisconfigured:
			outcomes[stage.Capability] = engine.OutcomeMisconfigured
			o.skipEngineStage(ctx, run.ID, capName, seq, "misconfigured: "+stage.Reason)
			// Advisory (configuration) diagnostic — never a code failure.
			_ = o.repo.InsertDiagnostics(ctx, run.ID, capName, []AgentDiagnostic{{
				Severity: "warning", Category: "configuration", Message: stage.Reason,
				Tool: "validation_planner", Origin: "planner", Confidence: 0.9, RepairCategory: "configuration",
			}})
			continue
		}

		// Cascade: skip when a dependency hard-failed (Failed / InfraError).
		if dep, blocked := engineBlocked(stage, outcomes); blocked {
			outcomes[stage.Capability] = engine.OutcomeSkipped
			o.skipEngineStage(ctx, run.ID, capName, seq, "skipped: dependency '"+string(dep)+"' did not pass")
			continue
		}

		// Execute.
		row, err := o.repo.CreateStage(ctx, run.ID, capName, seq, stage.Command)
		if err != nil || row == nil {
			log.Errorw("engine_create_stage_failed", "stage", capName, "error", err)
			continue
		}
		_ = o.repo.MarkStageRunning(ctx, row.ID)
		o.publish(run.ID, "stage_start", map[string]interface{}{
			"stage": capName, "seq": seq, "command": stage.Command,
		})

		res, combined, durationMS := o.execEngineCommand(ctx, run.ID, containerID, stage)
		outcome, origin, diags := engine.Classify(stage.Capability, res)
		passed := outcome == engine.OutcomePassed || outcome == engine.OutcomeNoTests

		_ = o.repo.CompleteStage(ctx, row.ID, res.ExitCode,
			truncateStr(res.Stdout, 256*1024), truncateStr(res.Stderr, 256*1024),
			truncateStr(combined, 512*1024), durationMS, passed)
		if len(diags) > 0 {
			_ = o.repo.InsertDiagnostics(ctx, run.ID, capName, mapEngineDiagnostics(diags, origin))
		}
		o.publish(run.ID, "stage_completed", map[string]interface{}{
			"stage": capName, "exit_code": res.ExitCode, "stage_passed": passed, "outcome": string(outcome),
		})

		outcomes[stage.Capability] = outcome
		if outcome == engine.OutcomeInfraError {
			hasEnvFailure = true
		}
		if stage.Capability == engine.CapInstall && !passed {
			installPassed = false
		}
		if stage.Capability == engine.CapBuild && !passed {
			buildPassed = false
		}

		// Honor Stop between stages.
		if ctx.Err() != nil {
			markCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = o.repo.MarkCancelled(markCtx, run.ID)
			cancel()
			o.publish(run.ID, "validation_cancelled", map[string]interface{}{
				"after_stage": capName, "reason": "context_cancelled",
			})
			return
		}
	}
	return
}

func (o *ValidationOrchestrator) skipEngineStage(ctx context.Context, runID, name string, seq int, reason string) {
	stage, _ := o.repo.CreateStage(ctx, runID, name, seq, nil)
	if stage != nil {
		_ = o.repo.SkipStage(ctx, stage.ID)
	}
	o.publish(runID, "stage_skipped", map[string]interface{}{"stage": name, "reason": reason})
}

// execEngineCommand runs one stage command, streaming output as stage_output
// events, and returns the raw result (for classification) + combined output +
// duration.
func (o *ValidationOrchestrator) execEngineCommand(
	ctx context.Context, runID, containerID string, stage engine.StageSpec,
) (engine.CommandResult, string, int) {
	var stdoutB, stderrB, combinedB strings.Builder
	exitCode := 0
	timedOut := false
	start := time.Now()

	stageCtx, cancel := context.WithTimeout(ctx, time.Duration(stage.TimeoutSec+30)*time.Second)
	defer cancel()

	ch, execErr := o.wsManager.ExecInValidationContainer(stageCtx, containerID, workspace.ExecRequest{
		Command:        stage.Command,
		WorkingDir:     dirOrDot(stage.WorkingDir),
		TimeoutSeconds: stage.TimeoutSec,
		Env:            stage.Env,
	})
	if execErr != nil {
		msg := execErr.Error()
		// Launch failure ≈ tool/infra problem; 127 routes to InfraError.
		return engine.CommandResult{ExitCode: 127, Stderr: msg}, msg, int(time.Since(start).Milliseconds())
	}

	for ev := range ch {
		switch ev.Type {
		case "stdout":
			c := string(ev.Data)
			stdoutB.WriteString(c)
			combinedB.WriteString(c)
			o.publish(runID, "stage_output", map[string]interface{}{"stage": string(stage.Capability), "chunk": c})
		case "stderr":
			c := string(ev.Data)
			stderrB.WriteString(c)
			combinedB.WriteString(c)
			o.publish(runID, "stage_output", map[string]interface{}{"stage": string(stage.Capability), "chunk": c})
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
	}, combinedB.String(), int(time.Since(start).Milliseconds())
}

// engineBlocked reports the first dependency that hard-failed.
func engineBlocked(stage engine.StageSpec, outcomes map[engine.Capability]engine.Outcome) (engine.Capability, bool) {
	for _, dep := range stage.DependsOn {
		switch outcomes[dep] {
		case engine.OutcomeFailed, engine.OutcomeInfraError:
			return dep, true
		}
	}
	return "", false
}

// mapEngineDiagnostics converts engine diagnostics to the persisted
// AgentDiagnostic shape, routing the repair category by failure origin.
func mapEngineDiagnostics(diags []engine.Diagnostic, origin engine.FailureOrigin) []AgentDiagnostic {
	category, repair := "code_error", "code"
	switch origin {
	case engine.OriginInfrastructure, engine.OriginTooling:
		category, repair = "environment_error", "environment_limitation"
	case engine.OriginConfiguration:
		category, repair = "configuration", "configuration"
	}
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
