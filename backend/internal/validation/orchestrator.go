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
	"github.com/charkhaniakash/forge-engine/backend/internal/validation/environment"
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
	envDetector *environment.Detector
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
		envDetector: environment.NewDetector(),
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
) (*models.ValidationRun, error) {
	ctx = ingestion.WithTraceID(ctx, traceID)
	log := o.logger.With("task_exec_id", taskExecutionID, "workspace_id", workspaceID)

	// 1. Detect stack by inspecting the Phase 7 workspace filesystem.
	detection, err := o.detector.Detect(ctx, workspaceID)
	if err != nil {
		log.Errorw("stack_detection_failed", "error", err)
		return nil, fmt.Errorf("stack detection: %w", err)
	}
	log.Infow("stack_detected",
		"stack", detection.Language,
		"framework", detection.Framework,
		"profile", detection.ProfileID)

	// 2. Load validation profile — this tells us which sandbox image to use.
	profile := GetProfile(detection.ProfileID)
	if profile == nil {
		return nil, fmt.Errorf("no validation profile found for %s", detection.ProfileID)
	}

	// 3. Create run row before provisioning the container (captures detection result).
	run, err := o.repo.CreateRun(ctx, taskExecutionID, workspaceID, detection, runType)
	if err != nil {
		return nil, fmt.Errorf("create validation run: %w", err)
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
		return nil, provisionErr
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

	// Pre-flight: verify the primary toolchain executable is available inside
	// the validation container before running any stages. This produces a clear
	// diagnostic immediately rather than a cryptic exit code mid-pipeline.
	primaryTool := _primaryToolForStack(detection.Language)
	if primaryTool != "" {
		pfCtx, pfCancel := context.WithTimeout(ctx, 10*time.Second)
		pfCh, pfErr := o.wsManager.ExecInValidationContainer(pfCtx, validationContainerID, workspace.ExecRequest{
			Command:        []string{"which", primaryTool},
			TimeoutSeconds: 10,
		})
		if pfErr == nil {
			pfExitCode := 0
			for ev := range pfCh {
				if ev.Type == "exit" && ev.ExitCode != nil {
					pfExitCode = *ev.ExitCode
				}
			}
			if pfExitCode != 0 {
				log.Errorw("validation_toolchain_missing",
					"tool", primaryTool,
					"image", profile.SandboxImage,
					"container_id", validationContainerID[:min(12, len(validationContainerID))],
				)
				// Synthesize a clear diagnostic and fail the run immediately.
				_ = o.repo.MarkError(ctx, run.ID,
					fmt.Sprintf("toolchain check failed: '%s' not found in %s container — image may not be built", primaryTool, profile.SandboxImage))
				o.publish(run.ID, "error", map[string]interface{}{
					"message": fmt.Sprintf("'%s' not found in container from image %s. Run 'docker compose build sandbox-%s' to rebuild the image.", primaryTool, profile.SandboxImage, detection.Language),
				})
				pfCancel()
				return nil, fmt.Errorf("toolchain missing: %s not found in %s", primaryTool, profile.SandboxImage)
			}
			log.Infow("validation_toolchain_verified", "tool", primaryTool, "image", profile.SandboxImage)
		}
		pfCancel()
	}

	// 5. Run stages in sequence inside the validation container.
	buildPassed := true
	installPassed := true // track install separately to skip downstream stages
	hasEnvironmentFailure := false // tracks if any stage was diagnosed as environment failure
	for _, stageCfg := range profile.Stages {
		// Skip stages if install failed (cascading failure prevention)
		if !installPassed && !stageCfg.RunOnInstallFail {
			stage, _ := o.repo.CreateStage(ctx, run.ID, stageCfg.Name, stageCfg.SequenceNumber, nil)
			if stage != nil {
				_ = o.repo.SkipStage(ctx, stage.ID)
			}
			o.publish(run.ID, "stage_skipped", map[string]interface{}{
				"stage":  stageCfg.Name,
				"reason": "install_failed",
			})
			continue
		}
		// Skip stages if build failed (existing logic)
		if !buildPassed && !stageCfg.RunOnBuildFail {
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

		stagePassed, isEnvFailure, err := o.runStage(ctx, run, profile, stageCfg, validationContainerID, log)
		if err != nil {
			log.Errorw("stage_run_error", "stage", stageCfg.Name, "error", err)
		}
		if isEnvFailure {
			hasEnvironmentFailure = true
		}
		if stageCfg.Name == "install" && !stagePassed {
			installPassed = false
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
		return nil, err
	}

	overallResult := computeOverallResultWithOrigin(fullRun.Stages, fullRun.Summary, hasEnvironmentFailure)
	if overallResult == "passed" {
		_ = o.repo.MarkCompleted(ctx, run.ID, overallResult)
	} else {
		_ = o.repo.MarkFailed(ctx, run.ID, overallResult)
	}

	// Stamp overallResult onto fullRun in-memory so the caller (main.go trigger)
	// sees the populated value without a second round-trip to the DB.
	// MarkCompleted/MarkFailed write overall_result to the DB AFTER fullRun was
	// loaded, so fullRun.OverallResult would otherwise be nil at this point.
	fullRun.OverallResult = &overallResult

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
	return fullRun, nil
}

// runStage executes one stage inside the validation container, persists results,
// collects repo evidence on failure, calls the agent to parse and diagnose output,
// and streams events.
// Returns (stagePassed, isEnvironmentFailure, error).
func (o *ValidationOrchestrator) runStage(
	ctx context.Context,
	run *models.ValidationRun,
	profile *ValidationProfile,
	stageCfg StageConfig,
	validationContainerID string,
	log *zap.SugaredLogger,
) (bool, bool, error) {
	log = log.With("stage", stageCfg.Name, "seq", stageCfg.SequenceNumber)

	var allCmds []string
	if len(stageCfg.Commands) > 0 {
		allCmds = stageCfg.Commands[0]
	}
	stage, err := o.repo.CreateStage(ctx, run.ID, stageCfg.Name, stageCfg.SequenceNumber, allCmds)
	if err != nil {
		return false, false, fmt.Errorf("create stage row: %w", err)
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

	for _, cmd := range stageCfg.Commands {
		stageCtx, cancel := context.WithTimeout(ctx, time.Duration(stageCfg.TimeoutSeconds)*time.Second)

		// Diagnostic logging for ESLint investigation
		if stageCfg.Name == "lint" && len(cmd) > 0 && cmd[0] == "npx" {
			// Log working directory
			pwdCh, _ := o.wsManager.ExecInValidationContainer(stageCtx, validationContainerID, workspace.ExecRequest{
				Command:        []string{"pwd"},
				TimeoutSeconds: 5,
			})
			pwdOutput := ""
			for ev := range pwdCh {
				if ev.Type == "stdout" {
					pwdOutput += string(ev.Data)
				}
			}
			log.Infow("lint_diagnostic_working_dir", "pwd", strings.TrimSpace(pwdOutput))

			// Check for .eslintignore
			ignoreCh, _ := o.wsManager.ExecInValidationContainer(stageCtx, validationContainerID, workspace.ExecRequest{
				Command:        []string{"cat", ".eslintignore"},
				TimeoutSeconds: 5,
			})
			ignoreOutput := ""
			for ev := range ignoreCh {
				if ev.Type == "stdout" {
					ignoreOutput += string(ev.Data)
				}
			}
			if ignoreOutput != "" {
				log.Infow("lint_diagnostic_eslintignore", "content", strings.TrimSpace(ignoreOutput))
			} else {
				log.Infow("lint_diagnostic_eslintignore", "content", "not_found")
			}

			// List workspace contents (first 50 files)
			lsCh, _ := o.wsManager.ExecInValidationContainer(stageCtx, validationContainerID, workspace.ExecRequest{
				Command:        []string{"find", ".", "-type", "f", "-name", "*.js", "-o", "-name", "*.jsx", "-o", "-name", "*.ts", "-o", "-name", "*.tsx"},
				TimeoutSeconds: 10,
			})
			lsOutput := ""
			for ev := range lsCh {
				if ev.Type == "stdout" {
					lsOutput += string(ev.Data)
				}
			}
			files := strings.Split(lsOutput, "\n")
			fileCount := len(files)
			filePreview := ""
			if fileCount > 0 {
				previewCount := min(20, fileCount)
				filePreview = strings.Join(files[:previewCount], "\n")
			}
			log.Infow("lint_diagnostic_workspace_files", "count", fileCount, "preview", filePreview)
		}

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
				return true, false, nil
			}
			return false, false, fmt.Errorf("exec %v: %w", cmd, execErr)
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

		if exitCode == 127 {
			if stageCfg.Optional {
				_ = o.repo.SkipStage(ctx, stage.ID)
				o.publish(run.ID, "stage_skipped", map[string]interface{}{
					"stage":  stageCfg.Name,
					"reason": "tool_not_found",
				})
				return true, false, nil
			}
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
				RepairCategory: "environment_limitation",
			}
			_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{infraDiag})
			break
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

	// ── Environment failure detection (before agent parsing) ─────────────────
	// Detect infrastructure failures that should not be treated as code errors.
	// This runs BEFORE the agent parser to ensure correct classification.
	isEnvironmentFailure := false
	envResult := o.envDetector.Detect(combined, exitCode, stageCfg.Name)
	if envResult != nil && envResult.IsFailure() {
		envDiag := AgentDiagnostic{
			Severity:       "error",
			Category:       envResult.Category,
			Message:        envResult.Message,
			Tool:           "validation_orchestrator",
			Origin:         "stderr",
			Confidence:     envResult.Confidence,
			RepairCategory: "environment_limitation",
		}
		_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{envDiag})
		// Mark as environment failure so we skip agent parsing
		isEnvironmentFailure = true
	}

	if timedOut {
		timeoutDiag := AgentDiagnostic{
			Severity:       "error",
			Category:       "environment_error",
			Message:        fmt.Sprintf("Stage '%s' timed out after %ds.", stageCfg.Name, stageCfg.TimeoutSeconds),
			Tool:           "validation_orchestrator",
			Origin:         "stderr",
			Confidence:     1.0,
			RepairCategory: "environment_limitation",
		}
		_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{timeoutDiag})
		isEnvironmentFailure = true
	}

	// Exit code 134 = SIGABRT (often caused by OOM in Node.js)
	if exitCode == 134 {
		oomDiag := AgentDiagnostic{
			Severity:       "error",
			Category:       "environment_error",
			Message:        fmt.Sprintf("Stage '%s' failed with exit code 134 (SIGABRT). This is typically caused by out-of-memory conditions during npm ci or similar operations. The validation container may need more memory.", stageCfg.Name),
			Tool:           "validation_orchestrator",
			Origin:         "stderr",
			Confidence:     1.0,
			RepairCategory: "environment_limitation",
		}
		_ = o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, []AgentDiagnostic{oomDiag})
		isEnvironmentFailure = true
	}

	_ = o.repo.CompleteStage(ctx, stage.ID, exitCode, stdout, stderr, combined, durationMS, stagePassed)

	o.publish(run.ID, "stage_complete", map[string]interface{}{
		"stage":       stageCfg.Name,
		"exit_code":   exitCode,
		"duration_ms": durationMS,
		"passed":      stagePassed,
	})

	// ── Parse output via agent with failure diagnosis ─────────────────────────
	// Skip if environment failure detected (above), exit 127 (already synthesized), or timeout.
	// Environment failures are already classified correctly by the orchestrator.
	if !isEnvironmentFailure && exitCode != 127 && !timedOut {
		// Collect repo evidence only when the stage failed — zero overhead on success.
		var evidence *RepoEvidence
		if !stagePassed {
			evidence = o.collectRepoEvidence(ctx, run.WorkspaceID, validationContainerID, run.Stack)
		}

		parseReq := ParseStageRequest{
			ValidationRunID: run.ID,
			Stage:           stageCfg.Name,
			Stack:           run.Stack,
			ExitCode:        exitCode,
			Stdout:          stdout,
			Stderr:          stderr,
			CombinedOutput:  combined,
			RepoEvidence:    evidence,
		}

		parseResp, parseErr := o.parseClient.ParseStage(ctx, parseReq)
		if parseErr != nil {
			log.Warnw("stage_parse_failed", "error", parseErr)
		}

		if parseResp != nil {
			// Propagate environment failure classification.
			if parseResp.FailureOrigin == "environment" {
				isEnvironmentFailure = true
				log.Infow("stage_environment_failure_diagnosed",
					"stage", stageCfg.Name,
					"explanation", parseResp.FailureExplanation)
				o.publish(run.ID, "stage_environment_failure", map[string]interface{}{
					"stage":       stageCfg.Name,
					"explanation": parseResp.FailureExplanation,
				})
			}
			if len(parseResp.Diagnostics) > 0 {
				if insertErr := o.repo.InsertDiagnostics(ctx, run.ID, stageCfg.Name, parseResp.Diagnostics); insertErr != nil {
					log.Warnw("insert_diagnostics_failed", "error", insertErr)
				}
				o.publish(run.ID, "stage_diagnostics", map[string]interface{}{
					"stage":          stageCfg.Name,
					"count":          len(parseResp.Diagnostics),
					"errors":         parseResp.ErrorCount,
					"warnings":       parseResp.WarningCount,
					"failure_origin": parseResp.FailureOrigin,
				})
			}
		}
	} else if exitCode == 127 {
		// exit 127 is always an environment failure.
		isEnvironmentFailure = true
	}

	return stagePassed, isEnvironmentFailure, nil
}

// collectRepoEvidence gathers repository metadata from the workspace to help
// the agent's FailureDiagnosis classify the failure origin.
// All reads are best-effort — missing files produce empty strings, never errors.
func (o *ValidationOrchestrator) collectRepoEvidence(
	ctx context.Context,
	workspaceID, validationContainerID, stack string,
) *RepoEvidence {
	ev := &RepoEvidence{}
	evCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	switch strings.ToLower(stack) {
	case "javascript", "node":
		// .nvmrc or .node-version
		if data, err := o.wsManager.ReadFile(evCtx, workspaceID, ".nvmrc"); err == nil {
			ev.NodeVersionFile = strings.TrimSpace(string(data))
		} else if data, err := o.wsManager.ReadFile(evCtx, workspaceID, ".node-version"); err == nil {
			ev.NodeVersionFile = strings.TrimSpace(string(data))
		}
		// package.json engines field
		if data, err := o.wsManager.ReadFile(evCtx, workspaceID, "package.json"); err == nil {
			ev.EnginesField = extractJSONField(string(data), "engines")
		}
		// Runtime version inside the validation container
		ch, err := o.wsManager.ExecInValidationContainer(evCtx, validationContainerID, workspace.ExecRequest{
			Command:        []string{"node", "--version"},
			TimeoutSeconds: 5,
		})
		if err == nil {
			var verBuf strings.Builder
			for event := range ch {
				if event.Type == "stdout" {
					verBuf.Write(event.Data)
				}
			}
			ev.NodeVersionInSandbox = strings.TrimSpace(verBuf.String())
		}
		// Lockfile
		for _, lf := range []string{"package-lock.json", "yarn.lock", "pnpm-lock.yaml"} {
			if ok, _ := o.wsManager.Exists(evCtx, workspaceID, lf); ok {
				ev.LockfilePresent = true
				ev.LockfileName = lf
				break
			}
		}

	case "python":
		if data, err := o.wsManager.ReadFile(evCtx, workspaceID, "pyproject.toml"); err == nil {
			ev.PythonRequires = extractTOMLField(string(data), "requires-python")
		}
		if ok, _ := o.wsManager.Exists(evCtx, workspaceID, "Pipfile.lock"); ok {
			ev.LockfilePresent = true
			ev.LockfileName = "Pipfile.lock"
		}

	case "go":
		if data, err := o.wsManager.ReadFile(evCtx, workspaceID, "go.mod"); err == nil {
			ev.GoVersionInMod = extractGoVersion(string(data))
		}
		if ok, _ := o.wsManager.Exists(evCtx, workspaceID, "go.sum"); ok {
			ev.LockfilePresent = true
			ev.LockfileName = "go.sum"
		}
	}
	return ev
}

// ── Evidence extraction helpers ───────────────────────────────────────────────

// extractJSONField extracts a top-level field from a JSON string without
// importing a full JSON parser — avoids having to unmarshal the whole object.
func extractJSONField(jsonStr, field string) string {
	// Look for "field": { ... } or "field": "..."
	// Simple approach: find the key and extract the value as a raw substring.
	key := `"` + field + `"`
	idx := strings.Index(jsonStr, key)
	if idx < 0 {
		return ""
	}
	after := strings.TrimSpace(jsonStr[idx+len(key):])
	if !strings.HasPrefix(after, ":") {
		return ""
	}
	val := strings.TrimSpace(after[1:])
	if strings.HasPrefix(val, "{") {
		// Object value — find matching closing brace.
		depth := 0
		for i, ch := range val {
			if ch == '{' {
				depth++
			} else if ch == '}' {
				depth--
				if depth == 0 {
					return val[:i+1]
				}
			}
		}
	}
	if strings.HasPrefix(val, `"`) {
		end := strings.Index(val[1:], `"`)
		if end >= 0 {
			return val[1 : end+1]
		}
	}
	return ""
}

// extractTOMLField extracts a simple key = "value" field from a TOML string.
func extractTOMLField(tomlStr, field string) string {
	for _, line := range strings.Split(tomlStr, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, field) {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				return strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			}
		}
	}
	return ""
}

// extractGoVersion extracts the "go X.Y" version line from go.mod.
func extractGoVersion(gomod string) string {
	for _, line := range strings.Split(gomod, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "go ") {
			return strings.TrimPrefix(line, "go ")
		}
	}
	return ""
}

func (o *ValidationOrchestrator) publish(runID, eventType string, payload map[string]interface{}) {
	if o.publisher != nil {
		o.publisher(runID, eventType, payload)
	}
}

// computeOverallResult classifies the validation run for Phase 9 consumption.
//
// Priority order:
//  1. Any stage failed with failure_origin=environment → "failed_environment"
//     (environment cannot reproduce the project — not a code failure)
//  2. Any stage failed with needs_human diagnostic → "failed_requires_human"
//  3. Any stage failed (code error) → "failed_repairable"
//  4. All stages passed or skipped → "passed"
//
// Stage statuses are the PRIMARY signal. Diagnostic counts are secondary.
func computeOverallResult(stages []*models.ValidationStage, s *models.ValidationSummary) string {
	// Check stage statuses first — this catches infrastructure failures
	// (exit 127, timeouts) that produce no structured diagnostics.
	for _, st := range stages {
		if st.Status == "failed" || st.Status == "error" {
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

// computeOverallResultWithOrigin extends computeOverallResult to distinguish
// environment failures from code failures. Called when failure_origin data
// is available from the parse-stage responses.
func computeOverallResultWithOrigin(stages []*models.ValidationStage, s *models.ValidationSummary, hasEnvironmentFailure bool) string {
	allFailed := false
	for _, st := range stages {
		if st.Status == "failed" || st.Status == "error" {
			allFailed = true
			break
		}
	}
	if !allFailed {
		if s == nil || (s.TotalErrors == 0 && s.NeedsHumanCount == 0) {
			return "passed"
		}
		if s.NeedsHumanCount > 0 {
			return "failed_requires_human"
		}
		return "failed_repairable"
	}
	// A stage failed. Distinguish environment vs code.
	if hasEnvironmentFailure {
		return "failed_environment"
	}
	if s != nil && s.NeedsHumanCount > 0 {
		return "failed_requires_human"
	}
	return "failed_repairable"
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

// _primaryToolForStack returns the executable whose presence confirms the
// language toolchain is installed in the validation container.
// Used for the pre-flight check before running any validation stages.
func _primaryToolForStack(language string) string {
	switch language {
	case "go":
		return "go"
	case "javascript", "node":
		return "npm"
	case "python":
		return "python3"
	default:
		return ""
	}
}

// Ensure bytes import is used.
var _ = bytes.Buffer{}
