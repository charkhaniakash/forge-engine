package validation

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// ValidationEventPublisher fans NDJSON events to the WebSocket hub.
type ValidationEventPublisher func(validationRunID string, eventType string, payload map[string]interface{})

// ContainerRunner is the interface the ValidationOrchestrator uses to provision
// and tear down short-lived language-specific validation containers.
// It is satisfied by workspace.WorkspaceManager.
type ContainerRunner interface {
	// ProvisionEphemeral creates an ephemeral container from the given image,
	// executes commands inside it, and returns a handle (containerID).
	// The caller is responsible for calling DestroyEphemeral when done.
	ProvisionEphemeral(ctx context.Context, image, workspaceID string) (string, error)

	// ExecInContainer runs a command in an existing container by ID.
	ExecInContainer(ctx context.Context, containerID string, req workspace.ExecRequest) (<-chan workspace.ExecutionEvent, error)

	// DestroyEphemeral removes the ephemeral container.
	DestroyEphemeral(ctx context.Context, containerID string) error

	// Exists checks if a path exists in the Phase 7 workspace (used for stack detection).
	Exists(ctx context.Context, workspaceID string, path string) (bool, error)

	// ReadFile reads a file from the Phase 7 workspace (used for package.json inspection).
	ReadFile(ctx context.Context, workspaceID string, path string) ([]byte, error)
}

// ValidationOrchestrator runs the full validation pipeline for one run.
//
// Sandbox model (Phase 8):
//   - Stack detection inspects the Phase 7 workspace (existing code container).
//   - Validation commands run inside a SEPARATE ephemeral container provisioned
//     from the language-specific image (forge-sandbox-go, forge-sandbox-node,
//     forge-sandbox-python). This ensures the correct toolchain is available.
//   - The code from the Phase 7 workspace is copied into the validation container
//     via a shared Docker volume (forge-workspace-<workspaceID>).
//   - The ephemeral validation container is destroyed after the run completes.
//
// Ownership: Go runs commands, captures output, persists results.
// Agent: parses raw output into structured diagnostics (per stage).
// Neither side modifies code.
type ValidationOrchestrator struct {
	repo        *ValidationRepository
	wsManager   *workspace.WorkspaceManager
	parseClient *AgentParseClient
	detector    *StackDetector
	publisher   ValidationEventPublisher
	logger      *zap.SugaredLogger
}

func NewValidationOrchestrator(
	repo *ValidationRepository,
	wsManager *workspace.WorkspaceManager,
	parseClient *AgentParseClient,
	detector *StackDetector,
	publisher ValidationEventPublisher,
	logger *zap.SugaredLogger,
) *ValidationOrchestrator {
	return &ValidationOrchestrator{
		repo:        repo,
		wsManager:   wsManager,
		parseClient: parseClient,
		detector:    detector,
		publisher:   publisher,
		logger:      logger,
	}
}

func (o *ValidationOrchestrator) SetPublisher(pub ValidationEventPublisher) {
	o.publisher = pub
}

// Run detects the stack, provisions a language-specific validation container,
// and executes all validation stages inside it. Called as a goroutine.
//
// Key design point: validation runs inside a SEPARATE ephemeral container
// provisioned from the language-specific sandbox image (e.g. forge-sandbox-node:latest).
// This is different from the Phase 7 workspace container (forge-sandbox:latest).
// The code volume is shared between the two containers via a named Docker volume,
// so the validation container sees the post-execution filesystem state.
func (o *ValidationOrchestrator) Run(
	ctx context.Context,
	taskExecutionID, workspaceID, traceID string,
	runType string,
) error {
	ctx = ingestion.WithTraceID(ctx, traceID)
	log := o.logger.With("task_exec_id", taskExecutionID, "workspace_id", workspaceID)

	// 1. Detect stack by inspecting the Phase 7 workspace filesystem.
	detection, err := o.detector.Detect(ctx, workspaceID)
	if err != nil {
		log.Errorw("stack_detection_failed", "error", err)
		return fmt.Errorf("stack detection: %w", err)
	}
	log.Infow("stack_detected",
		"stack", detection.Language,
		"framework", detection.Framework,
		"profile", detection.ProfileID)

	// 2. Load validation profile — this tells us which sandbox image to use.
	profile := GetProfile(detection.ProfileID)
	if profile == nil {
		return fmt.Errorf("no validation profile found for %s", detection.ProfileID)
	}

	// 3. Create run row before provisioning the container (captures detection result).
	run, err := o.repo.CreateRun(ctx, taskExecutionID, workspaceID, detection, runType)
	if err != nil {
		return fmt.Errorf("create validation run: %w", err)
	}
	log = log.With("validation_run_id", run.ID)

	_ = o.repo.MarkRunning(ctx, run.ID)
	o.publish(run.ID, "validation_start", map[string]interface{}{
		"profile": profile.ID,
		"stack":   detection.Language,
	})

	// 4. Provision an ephemeral language-specific container for validation.
	// The container mounts the same forge-workspace-<workspaceID> volume so it
	// sees the code that Phase 7 produced. It runs the language toolchain from
	// the correct image (forge-sandbox-node:latest, forge-sandbox-go:latest, etc.).
	validationContainerID, provisionErr := o.wsManager.ProvisionValidationContainer(
		ctx, workspaceID, profile.SandboxImage,
	)
	if provisionErr != nil {
		log.Errorw("validation_container_provision_failed",
			"image", profile.SandboxImage, "error", provisionErr)
		_ = o.repo.MarkError(ctx, run.ID, fmt.Sprintf("failed to provision validation container (%s): %v", profile.SandboxImage, provisionErr))
		o.publish(run.ID, "error", map[string]interface{}{
			"message": fmt.Sprintf("Could not start %s validation container: %v", profile.SandboxImage, provisionErr),
		})
		return provisionErr
	}
	// Always destroy the ephemeral container when done — even on error.
	defer func() {
		destroyCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := o.wsManager.DestroyValidationContainer(destroyCtx, validationContainerID); err != nil {
			log.Warnw("validation_container_destroy_failed",
				"container_id", validationContainerID[:min(12, len(validationContainerID))],
				"error", err)
		}
	}()

	log.Infow("validation_container_ready",
		"container_id", validationContainerID[:min(12, len(validationContainerID))],
		"image", profile.SandboxImage)

	// 5. Run stages in sequence inside the validation container.
	buildPassed := true
	for _, stageCfg := range profile.Stages {
		if !buildPassed && !stageCfg.RunOnBuildFail {
			// Skip this stage — build failed and it's not configured to run anyway.
			stage, _ := o.repo.CreateStage(ctx, run.ID, stageCfg.Name, stageCfg.SequenceNumber, nil)
			if stage != nil {
				_ = o.repo.SkipStage(ctx, stage.ID)
			}
			o.publish(run.ID, "stage_skipped", map[string]interface{}{
				"stage":  stageCfg.Name,
				"reason": "build_failed",
			})
			continue
		}

		stagePassed, err := o.runStage(ctx, run, profile, stageCfg, validationContainerID, log)
		if err != nil {
			log.Errorw("stage_run_error", "stage", stageCfg.Name, "error", err)
			// Non-fatal for the overall pipeline — continue to next stage.
		}

		if stageCfg.Name == "build" && !stagePassed {
			buildPassed = false
		}
	}

	// 6. Assemble the full result and compute the overall classification.
	fullRun, err := o.repo.GetRunWithFullResult(ctx, run.ID)
	if err != nil {
		log.Errorw("get_full_result_failed", "error", err)
		_ = o.repo.MarkError(ctx, run.ID, err.Error())
		return err
	}

	overallResult := computeOverallResult(fullRun.Stages, fullRun.Summary)
	if overallResult == "passed" {
		_ = o.repo.MarkCompleted(ctx, run.ID, overallResult)
	} else {
		_ = o.repo.MarkFailed(ctx, run.ID, overallResult)
	}

	summary := fullRun.Summary
	if summary == nil {
		summary = &models.ValidationSummary{}
	}
	o.publish(run.ID, "validation_complete", map[string]interface{}{
		"overall":        overallResult,
		"total_errors":   summary.TotalErrors,
		"total_warnings": summary.TotalWarnings,
		"build_passed":   summary.BuildPassed,
		"tests_passed":   summary.TestsPassed,
	})

	log.Infow("validation_complete", "overall", overallResult)
	return nil
}

// runStage executes one stage inside the validation container, persists results,
// calls the agent to parse output, and streams events.
// Returns (stagePassed, error).
func (o *ValidationOrchestrator) runStage(
	ctx context.Context,
	run *models.ValidationRun,
	profile *ValidationProfile,
	stageCfg StageConfig,
	validationContainerID string,
	log *zap.SugaredLogger,
) (bool, error) {
	log = log.With("stage", stageCfg.Name, "seq", stageCfg.SequenceNumber)

	var allCmds []string
	if len(stageCfg.Commands) > 0 {
		allCmds = stageCfg.Commands[0]
	}
	stage, err := o.repo.CreateStage(ctx, run.ID, stageCfg.Name, stageCfg.SequenceNumber, allCmds)
	if err != nil {
		return false, fmt.Errorf("create stage row: %w", err)
	}
	_ = o.repo.MarkStageRunning(ctx, stage.ID)

	o.publish(run.ID, "stage_start", map[string]interface{}{
		"stage":   stageCfg.Name,
		"seq":     stageCfg.SequenceNumber,
		"command": allCmds,
	})

	var combinedBuf strings.Builder
	var stdoutBuf strings.Builder
	var stderrBuf strings.Builder
	exitCode := 0
	timedOut := false
	start := time.Now()

	// Execute each command in the stage sequentially inside the validation container.
	for _, cmd := range stageCfg.Commands {
		stageCtx, cancel := context.WithTimeout(ctx, time.Duration(stageCfg.TimeoutSeconds)*time.Second)

		ch, execErr := o.wsManager.ExecInValidationContainer(stageCtx, validationContainerID, workspace.ExecRequest{
			Command:        cmd,
			WorkingDir:     ".",
			TimeoutSeconds: stageCfg.TimeoutSeconds,
		})
		if execErr != nil {
			cancel()
			if stageCfg.Optional {
				_ = o.repo.SkipStage(ctx, stage.ID)
				o.publish(run.ID, "stage_skipped", map[string]interface{}{
					"stage":  stageCfg.Name,
					"reason": "tool_not_found",
				})
				return true, nil
			}
			return false, fmt.Errorf("exec %v: %w", cmd, execErr)
		}

		for event := range ch {
			switch event.Type {
			case "stdout":
				chunk := string(event.Data)
				stdoutBuf.WriteString(chunk)
				combinedBuf.WriteString(chunk)
				o.publish(run.ID, "stage_output", map[string]interface{}{
					"stage": stageCfg.Name, "chunk": chunk,
				})
			case "stderr":
				chunk := string(event.Data)
				stderrBuf.WriteString(chunk)
				combinedBuf.WriteString(chunk)
				o.publish(run.ID, "stage_output", map[string]interface{}{
					"stage": stageCfg.Name, "chunk": chunk,
				})
			case "exit":
				if event.ExitCode != nil {
					exitCode = *event.ExitCode
				}
			case "timeout":
				timedOut = true
			}
		}
		cancel()

		// Exit 127 = executable not found in the container.
		// Optional stages (e.g. lint) are silently skipped.
		// Required stages produce a structured environment_error diagnostic.
		if exitCode == 127 {
			if stageCfg.Optional {
				_ = o.repo.SkipStage(ctx, stage.ID)
				o.publish(run.ID, "stage_skipped", map[string]interface{}{
					"stage":  stageCfg.Name,
					"reason": "tool_not_found",
				})
				return true, nil
			}
			// Required stage: synthesize a diagnostic so the UI shows something
			// meaningful instead of an empty diagnostics panel.
			toolName := ""
			if len(cmd) > 0 {
				toolName = cmd[0]
			}
			infraDiag := AgentDiagnostic{
				Severity:       "error",
				Category:       "environment_error",
				Message:        fmt.Sprintf("'%s' executable not found inside the validation container (%s). The sandbox image may be missing the required toolchain.", toolName, profile.SandboxImage),
				Tool:           "validation_orchestrator",
				Origin:         "stderr",
				Confidence:     1.0,
				RepairCategory: "needs_human",
			}
			_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{infraDiag})
			break // stop running further commands in this stage
		}

		if exitCode != 0 || timedOut {
			break
		}
	}

	durationMS := int(time.Since(start).Milliseconds())
	stagePassed := exitCode == 0 && !timedOut

	stdout := truncateStr(stdoutBuf.String(), 256*1024)
	stderr := truncateStr(stderrBuf.String(), 256*1024)
	combined := truncateStr(combinedBuf.String(), 512*1024)

	// Synthesize a timeout diagnostic so the user knows what happened.
	if timedOut {
		timeoutDiag := AgentDiagnostic{
			Severity:       "error",
			Category:       "environment_error",
			Message:        fmt.Sprintf("Stage '%s' timed out after %ds.", stageCfg.Name, stageCfg.TimeoutSeconds),
			Tool:           "validation_orchestrator",
			Origin:         "stderr",
			Confidence:     1.0,
			RepairCategory: "needs_human",
		}
		_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{timeoutDiag})
	}

	_ = o.repo.CompleteStage(ctx, stage.ID, exitCode, stdout, stderr, combined, durationMS, stagePassed)

	o.publish(run.ID, "stage_complete", map[string]interface{}{
		"stage":       stageCfg.Name,
		"exit_code":   exitCode,
		"duration_ms": durationMS,
		"passed":      stagePassed,
	})

	// Call the agent to parse structured output (only for non-infrastructure failures).
	// If exitCode == 127 we already synthesized the diagnostic above; skip parsing.
	if exitCode != 127 && !timedOut {
		parseReq := ParseStageRequest{
			ValidationRunID: run.ID,
			Stage:           stageCfg.Name,
			Stack:           run.Stack,
			ExitCode:        exitCode,
			Stdout:          stdout,
			Stderr:          stderr,
			CombinedOutput:  combined,
		}

		parseResp, parseErr := o.parseClient.ParseStage(ctx, parseReq)
		if parseErr != nil {
			log.Warnw("stage_parse_failed", "error", parseErr)
		}

		if parseResp != nil && len(parseResp.Diagnostics) > 0 {
			if insertErr := o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, parseResp.Diagnostics); insertErr != nil {
				log.Warnw("insert_diagnostics_failed", "error", insertErr)
			}
			o.publish(run.ID, "stage_diagnostics", map[string]interface{}{
				"stage":    stageCfg.Name,
				"count":    len(parseResp.Diagnostics),
				"errors":   parseResp.ErrorCount,
				"warnings": parseResp.WarningCount,
			})
		}
	}

	return stagePassed, nil
}

func (o *ValidationOrchestrator) publish(runID, eventType string, payload map[string]interface{}) {
	if o.publisher != nil {
		o.publisher(runID, eventType, payload)
	}
}

// computeOverallResult classifies the validation run for Phase 9 consumption.
//
// Rules (in priority order):
//  1. Any required stage failed or timed out → at minimum failed_repairable.
//  2. Any diagnostic with repair_category=needs_human → failed_requires_human.
//  3. Any error-severity diagnostic → failed_repairable.
//  4. Otherwise → passed.
//
// Critically: stage exit codes and statuses are the PRIMARY signal.
// Diagnostic counts are secondary — a stage can fail with zero diagnostics
// (e.g. exit 127 / tool not found) and must still produce a failed result.
func computeOverallResult(stages []*models.ValidationStage, s *models.ValidationSummary) string {
	// Check stage statuses first — this catches infrastructure failures
	// (exit 127, timeouts) that produce no structured diagnostics.
	for _, st := range stages {
		if st.Status == "failed" || st.Status == "error" {
			// A required stage (not skipped) failed → at minimum repairable.
			if s != nil && s.NeedsHumanCount > 0 {
				return "failed_requires_human"
			}
			return "failed_repairable"
		}
	}

	// All stages passed or skipped. Now check diagnostic severity.
	if s == nil {
		return "passed"
	}
	if s.NeedsHumanCount > 0 {
		return "failed_requires_human"
	}
	if s.TotalErrors > 0 {
		return "failed_repairable"
	}
	return "passed"
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n[truncated]"
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Ensure bytes import is used.
var _ = bytes.Buffer{}
