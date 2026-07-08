package repair

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

// Orchestrator owns the entire repair session loop.
// It coordinates RepairGraph invocations, re-runs Phase 8 validation,
// compares outcomes, and enforces budgets.
//
// Design principle: Go starts a brand-new RepairGraph for every attempt.
// The graph receives previous attempt summaries as input but has no
// cross-attempt state. Go is the only component that knows how many
// attempts have run and when to stop.
type Orchestrator struct {
	repairRepo       *RepairRepository
	validationRepo   *validation.ValidationRepository
	execRepo         *repository.ExecutionRepository
	workItemRepo     *repository.WorkItemRepository
	workspaceManager *workspace.WorkspaceManager
	validationOrch   *validation.ValidationOrchestrator
	agentClient      *AgentRepairClient
	policy           *RepairPolicy
	publisher        func(sessionID string, eventType string, payload map[string]interface{})
	jwtSecret        string
	logger           *zap.SugaredLogger
}

// NewOrchestrator constructs a RepairOrchestrator.
func NewOrchestrator(
	repairRepo *RepairRepository,
	validationRepo *validation.ValidationRepository,
	execRepo *repository.ExecutionRepository,
	workItemRepo *repository.WorkItemRepository,
	workspaceManager *workspace.WorkspaceManager,
	validationOrch *validation.ValidationOrchestrator,
	agentClient *AgentRepairClient,
	policy *RepairPolicy,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *Orchestrator {
	return &Orchestrator{
		repairRepo:       repairRepo,
		validationRepo:   validationRepo,
		execRepo:         execRepo,
		workItemRepo:     workItemRepo,
		workspaceManager: workspaceManager,
		validationOrch:   validationOrch,
		agentClient:      agentClient,
		policy:           policy,
		jwtSecret:        jwtSecret,
		logger:           logger,
	}
}

// SetPublisher wires the WebSocket publisher after construction.
// Called by NewHandlers to avoid an import cycle.
func (o *Orchestrator) SetPublisher(pub func(sessionID string, eventType string, payload map[string]interface{})) {
	o.publisher = pub
}

// publish fans a repair event to the WebSocket hub (no-op if no publisher set).
func (o *Orchestrator) publish(sessionID, eventType string, payload map[string]interface{}) {
	if o.publisher != nil {
		o.publisher(sessionID, eventType, payload)
	}
}

// isCancelled queries the DB to check whether the repair session has been cancelled.
func (o *Orchestrator) isCancelled(ctx context.Context, sessionID string) bool {
	session, err := o.repairRepo.GetSession(ctx, sessionID)
	if err != nil {
		o.logger.Warnw("cancel_check_db_error", "error", err)
		return false
	}
	return session.Status == "cancelled"
}

// Run executes the bounded repair loop for a task.
//
// Workflow:
//  1. Load validation run via GetRunWithFullResult()
//  2. RepairPolicy.Evaluate() → if !Allowed, escalate immediately
//  3. Create repair_sessions row (status=running)
//  4. Loop (attempt=1..max_attempts):
//     - Check cancel signal
//     - Check wall-clock budget
//     - Build RepairRequest with diagnostics + previous attempt summaries
//     - NEW RepairGraph invocation via AgentRepairClient.Repair()
//     - Drain NDJSON stream, persist events, apply file changes
//     - Save repair_attempts row + repair_checkpoints row
//     - Re-run Phase 8 ValidationOrchestrator
//     - Compare outcomes:
//     * passed → mark session completed, stop
//     * errors reduced → continue loop (improved)
//     * no change → escalate (strategy ineffective)
//     * regressed → roll back via checkpoint, escalate
//     - Check budget exhaustion
//  5. Final: mark session status, advance WorkItem
func (o *Orchestrator) Run(
	ctx context.Context,
	taskExecutionID, workspaceID, validationRunID, traceID string,
) error {
	log := o.logger.With(
		"task_execution_id", taskExecutionID,
		"workspace_id", workspaceID,
		"trigger_validation_run_id", validationRunID,
		"trace_id", traceID,
	)
	log.Info("repair_session_starting")

	// Resolve work_item_id — work item transitions use work_items.id, not task_executions.id.
	exec, err := o.execRepo.GetExecution(ctx, taskExecutionID)
	if err != nil {
		return fmt.Errorf("load task execution: %w", err)
	}
	workItemID := exec.WorkItemID
	log = log.With("work_item_id", workItemID)

	// 1. Load validation run with full diagnostics
	validationRun, err := o.validationRepo.GetRunWithFullResult(ctx, validationRunID)
	if err != nil {
		return fmt.Errorf("load validation run: %w", err)
	}

	// 2. RepairPolicy gate — evaluate before transitioning to repairing.
	decision := o.policy.Evaluate(validationRun)
	if !decision.Allowed {
		log.Warnw("repair_not_allowed", "reason", decision.DenialReason)
		if err := o.workItemRepo.TransitionToFailed(ctx, workItemID, "repair not permitted: "+decision.DenialReason); err != nil {
			log.Errorw("transition_to_failed_after_policy_deny", "error", err)
		}
		return fmt.Errorf("repair not permitted: %s", decision.DenialReason)
	}

	log.Infow("repair_allowed", "repairable_diagnostics", len(decision.RepairableDiags))

	if err := o.workItemRepo.TransitionToRepairing(ctx, workItemID); err != nil {
		log.Errorw("transition_to_repairing_failed", "error", err)
		return fmt.Errorf("transition to repairing: %w", err)
	}

	// 3. Create repair session
	session, err := o.repairRepo.CreateSession(
		ctx, taskExecutionID, workspaceID, validationRunID,
		DefaultMaxAttempts,
		DefaultMaxDurationSecs,
	)
	if err != nil {
		return fmt.Errorf("create repair session: %w", err)
	}

	log = log.With("repair_session_id", session.ID)
	log.Info("repair_session_created")

	// Publish session started event
	o.publish(session.ID, "repair_started", map[string]interface{}{
		"attempt":      1,
		"max_attempts": session.MaxAttempts,
	})

	// Create a cancellable context scoped to this session.
	// If the parent context cancels, all in-flight HTTP calls stop immediately.
	// The isCancelled DB check still runs as a belt-and-suspenders soft cancel.
	sessionCtx, cancelSession := context.WithCancel(ctx)
	defer cancelSession()

	// 4. Repair loop
	sessionStartTime := time.Now()
	lastValidationRunID := validationRunID // start with trigger validation

	for attemptNum := 1; attemptNum <= session.MaxAttempts; attemptNum++ {
		log := log.With("attempt_number", attemptNum)
		log.Info("repair_attempt_starting")

		// Check cancel signal via DB poll
		if o.isCancelled(sessionCtx, session.ID) {
			log.Infow("repair_session_cancelled")
			return fmt.Errorf("repair session cancelled")
		}

		// Check wall-clock budget
		elapsed := time.Since(sessionStartTime).Seconds()
		if elapsed > float64(session.MaxDurationSecs) {
			log.Warnw("repair_budget_exhausted_time", "elapsed_secs", elapsed)
			_ = o.repairRepo.MarkExhausted(sessionCtx, session.ID, lastValidationRunID)
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair budget exhausted (time)")
			return fmt.Errorf("repair time budget exhausted")
		}

		// Publish attempt starting event
		o.publish(session.ID, "attempt_started", map[string]interface{}{
			"attempt_number": attemptNum,
		})

		// Increment attempts counter
		if err := o.repairRepo.IncrementAttempts(sessionCtx, session.ID); err != nil {
			log.Errorw("failed to increment attempts", "error", err)
		}

		// Build previous attempt summaries from DB
		previousAttempts, err := o.buildPreviousAttemptSummaries(sessionCtx, session, attemptNum)
		if err != nil {
			log.Errorw("failed to build previous attempts", "error", err)
			previousAttempts = []map[string]interface{}{} // continue with empty
		}

		// Execute ONE repair attempt (brand-new graph)
		attemptResult, attemptErr := o.executeRepairAttempt(
			sessionCtx, session, attemptNum, decision.RepairableDiags, previousAttempts, traceID, log,
		)

		if attemptErr != nil {
			log.Errorw("repair_attempt_failed", "error", attemptErr)
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, fmt.Sprintf("attempt %d error: %v", attemptNum, attemptErr))
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, fmt.Sprintf("repair failed: %v", attemptErr))
			return attemptErr
		}

		// Check if agent declared cannot_repair
		if attemptResult.CannotRepair {
			log.Infow("agent_declared_cannot_repair", "reason", attemptResult.CannotRepairReason)
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, attemptResult.CannotRepairReason)
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair escalated: "+attemptResult.CannotRepairReason)
			o.publish(session.ID, "repair_escalated", map[string]interface{}{
				"reason": attemptResult.CannotRepairReason,
			})
			return fmt.Errorf("repair escalated: %s", attemptResult.CannotRepairReason)
		}

		// Re-run Phase 8 validation
		log.Info("running_post_repair_validation")
		postRepairRun, valErr := o.validationOrch.Run(sessionCtx, taskExecutionID, workspaceID, traceID, "post_repair")
		if valErr != nil {
			log.Errorw("post_repair_validation_failed", "error", valErr)
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, fmt.Sprintf("validation error: %v", valErr))
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, fmt.Sprintf("validation error: %v", valErr))
			return valErr
		}

		// Update attempt with post-repair validation ID
		_ = o.repairRepo.UpdateAttemptResult(
			sessionCtx, attemptResult.AttemptID, attemptResult.Reasoning,
			attemptResult.Strategy, attemptResult.Confidence,
			attemptResult.ModifiedFiles, &postRepairRun.ID, nil, // outcome determined below
		)

		lastValidationRunID = postRepairRun.ID

		// Compare outcomes (error-count + stage-transition based).
		outcome := o.compareValidationOutcomes(validationRun, postRepairRun, log)
		log.Infow("repair_outcome_determined", "outcome", outcome)

		// Concise per-attempt summary for observability.
		log.Infow("repair_attempt_summary",
			"attempt_number", attemptNum,
			"files_modified", attemptResult.ModifiedFiles,
			"errors_before", countErrorDiagnostics(validationRun.Diagnostics),
			"errors_after", countErrorDiagnostics(postRepairRun.Diagnostics),
			"stages_before", failingStageList(validationRun.Diagnostics),
			"stages_after", failingStageList(postRepairRun.Diagnostics),
			"repair_outcome", outcome,
		)

		// Update attempt outcome
		_ = o.repairRepo.UpdateAttemptResult(
			sessionCtx, attemptResult.AttemptID, attemptResult.Reasoning,
			attemptResult.Strategy, attemptResult.Confidence,
			attemptResult.ModifiedFiles, &postRepairRun.ID, &outcome,
		)

		// Publish attempt complete event
		o.publish(session.ID, "attempt_complete", map[string]interface{}{
			"outcome":        outcome,
			"modified_files": attemptResult.ModifiedFiles,
		})

		// Handle outcome
		switch outcome {
		case "passed":
			// Success!
			log.Info("repair_succeeded")
			_ = o.repairRepo.MarkCompleted(sessionCtx, session.ID, postRepairRun.ID)
			_ = o.workItemRepo.TransitionToDone(sessionCtx, workItemID)
			o.publish(session.ID, "repair_complete", map[string]interface{}{
				"final_result": "passed",
			})
			return nil

		case "improved":
			log.Info("repair_improved_continuing")
			// Continue to next attempt

		case "no_change":
			log.Warn("repair_no_change_escalating")
			reason := "repair strategy ineffective (no change)"
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, reason)
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair escalated: no improvement")
			o.publish(session.ID, "repair_escalated", map[string]interface{}{
				"reason": reason,
			})
			return fmt.Errorf("repair escalated: no improvement after attempt %d", attemptNum)

		case "regressed":
			log.Warn("repair_regressed_escalating")
			// Roll back via checkpoint diffs before escalating
			if rollbackErr := o.rollbackFromCheckpoint(sessionCtx, session.ID, attemptNum, workspaceID); rollbackErr != nil {
				log.Warnw("rollback_failed", "error", rollbackErr)
			}
			reason := "repair caused regression"
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, reason)
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair escalated: regression")
			o.publish(session.ID, "repair_escalated", map[string]interface{}{
				"reason": reason,
			})
			return fmt.Errorf("repair escalated: regression after attempt %d", attemptNum)

		case "error":
			log.Error("repair_outcome_error_escalating")
			reason := "error classifying repair outcome"
			_ = o.repairRepo.MarkEscalated(sessionCtx, session.ID, reason)
			_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair escalated: outcome error")
			o.publish(session.ID, "repair_escalated", map[string]interface{}{
				"reason": reason,
			})
			return fmt.Errorf("repair escalated: error after attempt %d", attemptNum)
		}
	}

	// Budget exhausted (attempts)
	log.Warn("repair_exhausted_max_attempts")
	_ = o.repairRepo.MarkExhausted(sessionCtx, session.ID, lastValidationRunID)
	_ = o.workItemRepo.TransitionToFailed(sessionCtx, workItemID, "repair budget exhausted (max attempts)")
	return fmt.Errorf("repair budget exhausted after %d attempts", session.MaxAttempts)
}

// RepairAttemptResult holds the structured output from one RepairGraph invocation.
type RepairAttemptResult struct {
	AttemptID          string
	Strategy           *string
	Confidence         *float64
	ModifiedFiles      []string
	Reasoning          json.RawMessage
	CannotRepair       bool
	CannotRepairReason string
}

// checkpointDiffEntry is the per-file entry stored in repair_checkpoints.unified_diffs.
// FileExisted records whether the file was present BEFORE repair began.
// This makes rollback deterministic:
//   - FileExisted == false → file was created by repair → delete on rollback
//   - FileExisted == true  → file was modified by repair → restore OriginalContent
// Note: OriginalContent may legitimately be an empty string even when FileExisted == true.
type checkpointDiffEntry struct {
	FilePath        string `json:"file_path"`
	DiffUnified     string `json:"diff_unified"`
	LinesAdded      int    `json:"lines_added"`
	LinesRemoved    int    `json:"lines_removed"`
	FileExisted     bool   `json:"file_existed"`     // true if file existed before repair
	OriginalContent string `json:"original_content"` // content before repair (may be "" for empty files)
}

// executeRepairAttempt runs ONE RepairGraph invocation and persists the attempt + checkpoint.
// It delegates to private helpers for each phase of the attempt.
func (o *Orchestrator) executeRepairAttempt(
	ctx context.Context,
	session *models.RepairSession,
	attemptNum int,
	diagnostics []*models.ValidationDiagnostic,
	previousAttempts []map[string]interface{},
	traceID string,
	log *zap.SugaredLogger,
) (*RepairAttemptResult, error) {
	// Create DB record for this attempt
	attempt, err := o.createAttemptRecord(ctx, session.ID, attemptNum, diagnostics)
	if err != nil {
		return nil, fmt.Errorf("create repair attempt: %w", err)
	}
	log = log.With("repair_attempt_id", attempt.ID)

	// Snapshot before-content for files mentioned in diagnostics
	beforeContent, beforeExisted := o.snapshotBeforeContent(ctx, session.WorkspaceID, diagnostics)

	// Build the request payload for the agent
	req := o.buildRepairRequest(session, attemptNum, diagnostics, previousAttempts, traceID)

	// Generate agent token
	token, err := ingestion.SignJWT(map[string]interface{}{
		"sub":        "backend",
		"session_id": session.ID,
		"attempt":    attemptNum,
		"iat":        time.Now().Unix(),
		"exp":        time.Now().Add(DefaultAgentTokenTTL * time.Second).Unix(),
	}, o.jwtSecret)
	if err != nil {
		return nil, fmt.Errorf("generate agent token: %w", err)
	}

	// Stream the agent, collecting results and lazily capturing before-content
	result, err := o.runAgentStream(ctx, session, req, token, beforeContent, beforeExisted, log)
	if err != nil {
		return nil, err
	}
	result.AttemptID = attempt.ID

	// Compute unified diffs and persist checkpoint
	diffs := o.collectCheckpointDiffs(ctx, session.WorkspaceID, result.ModifiedFiles, beforeContent, beforeExisted)
	if err := o.persistCheckpoint(ctx, session.ID, attemptNum, result, diffs, log); err != nil {
		log.Warnw("failed_to_create_checkpoint", "error", err)
	}

	return result, nil
}

// ── executeRepairAttempt helpers ──────────────────────────────────────────────

// createAttemptRecord creates the DB row for one repair attempt.
func (o *Orchestrator) createAttemptRecord(
	ctx context.Context,
	sessionID string,
	attemptNum int,
	diagnostics []*models.ValidationDiagnostic,
) (*models.RepairAttempt, error) {
	diagJSON, _ := json.Marshal(diagnostics)
	return o.repairRepo.CreateAttempt(ctx, sessionID, attemptNum, diagJSON, DefaultAgentVersion)
}

// snapshotBeforeContent reads before-content for files mentioned in diagnostics.
// Returns two maps: content (path → content) and existed (path → bool).
// Files that fail to read are recorded as not-existing (fileExisted=false).
func (o *Orchestrator) snapshotBeforeContent(
	ctx context.Context,
	workspaceID string,
	diagnostics []*models.ValidationDiagnostic,
) (content map[string]string, existed map[string]bool) {
	content = map[string]string{}
	existed = map[string]bool{}
	seen := map[string]bool{}
	for _, diag := range diagnostics {
		if diag.FilePath != nil && *diag.FilePath != "" && !seen[*diag.FilePath] {
			seen[*diag.FilePath] = true
			data, readErr := o.workspaceManager.ReadFile(ctx, workspaceID, *diag.FilePath)
			if readErr == nil {
				content[*diag.FilePath] = string(data)
				existed[*diag.FilePath] = true
			}
			// If readErr != nil the file doesn't exist yet; existed[path] stays false (zero value).
		}
	}
	return content, existed
}

// buildRepairRequest constructs the RepairRequest payload sent to the agent.
func (o *Orchestrator) buildRepairRequest(
	session *models.RepairSession,
	attemptNum int,
	diagnostics []*models.ValidationDiagnostic,
	previousAttempts []map[string]interface{},
	traceID string,
) RepairRequest {
	return RepairRequest{
		Version: 1,
		RepairContext: RepairContext{
			RepairSessionID: session.ID,
			TaskExecutionID: session.TaskExecutionID,
			WorkspaceID:     session.WorkspaceID,
			AttemptNumber:   attemptNum,
			TraceID:         traceID,
			Model:           DefaultModel,
			Temperature:     DefaultTemperature,
			MaxTokens:       DefaultMaxTokens,
		},
		Diagnostics:              diagnostics,
		PreviousAttemptSummaries: previousAttempts,
		RequestID:                fmt.Sprintf("repair-%s-%d", session.ID, attemptNum),
	}
}

// runAgentStream calls agentClient.Repair and collects results.
// It also lazily captures before-content when a write_file tool_call is first seen,
// guaranteeing we snapshot files the agent writes even if they weren't in diagnostics.
// Both beforeContent and beforeExisted maps are updated in place.
func (o *Orchestrator) runAgentStream(
	ctx context.Context,
	session *models.RepairSession,
	req RepairRequest,
	token string,
	beforeContent map[string]string,
	beforeExisted map[string]bool,
	log *zap.SugaredLogger,
) (*RepairAttemptResult, error) {
	result := &RepairAttemptResult{
		ModifiedFiles: []string{},
	}
	var reasoning []map[string]interface{}
	var timeline []map[string]interface{}

	streamErr := o.agentClient.Repair(ctx, req, token, func(event RepairStreamEvent) {
		log.Debugw("repair_stream_event", "event", event.Event)

		// Accumulate timeline entry for every event
		timeline = append(timeline, map[string]interface{}{
			"event":       event.Event,
			"message":     event.Message,
			"tool":        event.ToolName,
			"tool_call_id": event.ToolCallID,
			"success":     event.Success,
		})

		switch event.Event {
		case "reasoning":
			reasoning = append(reasoning, map[string]interface{}{
				"message": event.Message,
			})

		case "tool_call":
			log.Debugw("repair_tool_call", "tool", event.ToolName, "tool_call_id", event.ToolCallID)
			// Publish tool_call to WebSocket
			o.publish(session.ID, "tool_call", map[string]interface{}{
				"tool":         event.ToolName,
				"tool_call_id": event.ToolCallID,
			})
			// Lazily capture before-content for write_file targets not already snapshotted.
			// The tool_call event arrives BEFORE the tool executes, so this gives the pre-write state.
			if event.ToolName == "write_file" && len(event.ToolArgs) > 0 {
				var args struct {
					Path string `json:"path"`
				}
				if jsonErr := json.Unmarshal(event.ToolArgs, &args); jsonErr == nil && args.Path != "" {
					if _, alreadyCaptured := beforeContent[args.Path]; !alreadyCaptured {
						data, readErr := o.workspaceManager.ReadFile(ctx, session.WorkspaceID, args.Path)
						if readErr == nil {
							beforeContent[args.Path] = string(data)
							beforeExisted[args.Path] = true
						} else {
							// File does not exist yet — repair will create it.
							beforeContent[args.Path] = ""
							beforeExisted[args.Path] = false
						}
					}
				}
			}

		case "repair_complete":
			result.Strategy = &event.Strategy
			result.Confidence = &event.Confidence
			result.ModifiedFiles = event.ModifiedFiles
			reasoningJSON, _ := json.Marshal(map[string]interface{}{
				"summary":   event.Summary,
				"reasoning": reasoning,
				"timeline":  timeline,
			})
			result.Reasoning = reasoningJSON

		case "cannot_repair":
			result.CannotRepair = true
			result.CannotRepairReason = event.CannotRepairReason
			// Persist timeline in reasoning so the attempt record is complete
			reasoningJSON, _ := json.Marshal(map[string]interface{}{
				"summary":   "",
				"reasoning": reasoning,
				"timeline":  timeline,
			})
			result.Reasoning = reasoningJSON

		case "error":
			log.Errorw("repair_graph_error", "error", event.Error)
		}
	})

	if streamErr != nil {
		return nil, fmt.Errorf("repair stream error: %w", streamErr)
	}
	return result, nil
}

// collectCheckpointDiffs computes unified diffs for all files modified by the agent.
func (o *Orchestrator) collectCheckpointDiffs(
	ctx context.Context,
	workspaceID string,
	modifiedFiles []string,
	beforeContent map[string]string,
	beforeExisted map[string]bool,
) []checkpointDiffEntry {
	var entries []checkpointDiffEntry
	for _, filePath := range modifiedFiles {
		afterData, readErr := o.workspaceManager.ReadFile(ctx, workspaceID, filePath)
		afterContent := ""
		if readErr == nil {
			afterContent = string(afterData)
		}

		origContent := beforeContent[filePath]
		existed := beforeExisted[filePath]
		diffResult := execution.ComputeUnifiedDiff(filePath, origContent, afterContent)
		entries = append(entries, checkpointDiffEntry{
			FilePath:        filePath,
			DiffUnified:     diffResult.Unified,
			LinesAdded:      diffResult.LinesAdded,
			LinesRemoved:    diffResult.LinesRemoved,
			FileExisted:     existed,
			OriginalContent: origContent,
		})
	}
	if entries == nil {
		entries = []checkpointDiffEntry{}
	}
	return entries
}

// persistCheckpoint saves the checkpoint record to the database.
func (o *Orchestrator) persistCheckpoint(
	ctx context.Context,
	sessionID string,
	attemptNum int,
	result *RepairAttemptResult,
	diffs []checkpointDiffEntry,
	log *zap.SugaredLogger,
) error {
	diffsJSON, _ := json.Marshal(diffs)
	_, err := o.repairRepo.CreateCheckpoint(
		ctx, sessionID, attemptNum,
		result.ModifiedFiles, []string{}, []string{}, diffsJSON,
	)
	return err
}

// ── Checkpoint rollback ───────────────────────────────────────────────────────

// rollbackFromCheckpoint restores the workspace to its pre-repair state using
// the checkpoint for the given attempt.
//
// Rollback rules (deterministic — does not infer from OriginalContent):
//   - entry.FileExisted == false → file was created by repair → delete it
//   - entry.FileExisted == true  → file was modified by repair → restore OriginalContent
//     (OriginalContent may legitimately be "" for a file that was empty before repair)
func (o *Orchestrator) rollbackFromCheckpoint(
	ctx context.Context,
	sessionID string,
	attemptNum int,
	workspaceID string,
) error {
	cp, err := o.repairRepo.GetCheckpoint(ctx, sessionID, attemptNum)
	if err != nil {
		return fmt.Errorf("load checkpoint for rollback: %w", err)
	}

	var entries []checkpointDiffEntry
	if err := json.Unmarshal(cp.UnifiedDiffs, &entries); err != nil {
		return fmt.Errorf("parse checkpoint diffs: %w", err)
	}

	for _, entry := range entries {
		if !entry.FileExisted {
			// File was created by repair — delete it to restore prior state.
			if delErr := o.workspaceManager.DeleteFile(ctx, workspaceID, entry.FilePath); delErr != nil {
				o.logger.Warnw("rollback_delete_failed",
					"file", entry.FilePath,
					"error", delErr,
				)
			}
		} else {
			// File existed before repair — restore its original content.
			if writeErr := o.workspaceManager.WriteFile(ctx, workspaceID, entry.FilePath, []byte(entry.OriginalContent)); writeErr != nil {
				o.logger.Warnw("rollback_write_failed",
					"file", entry.FilePath,
					"error", writeErr,
				)
			}
		}
	}
	return nil
}

// ── Previous attempt summaries ────────────────────────────────────────────────

// buildPreviousAttemptSummaries constructs the previous_attempts array for the agent.
// Note: baseline_validation_run_id is duplicated in every summary entry to preserve
// the existing agent API contract — it is intentionally repeated rather than hoisted.
func (o *Orchestrator) buildPreviousAttemptSummaries(
	ctx context.Context,
	session *models.RepairSession,
	currentAttemptNum int,
) ([]map[string]interface{}, error) {
	if currentAttemptNum == 1 {
		return []map[string]interface{}{}, nil
	}

	attempts, err := o.repairRepo.ListAttemptsForSession(ctx, session.ID)
	if err != nil {
		return nil, err
	}

	var summaries []map[string]interface{}
	for _, att := range attempts {
		if att.AttemptNumber >= currentAttemptNum {
			break
		}
		summary := map[string]interface{}{
			"attempt_number":             att.AttemptNumber,
			"strategy":                   att.Strategy,
			"confidence":                 att.Confidence,
			"outcome":                    att.Outcome,
			"modified_files":             att.ModifiedFiles,
			"baseline_validation_run_id": session.TriggerValidationRunID,
		}
		if len(att.Reasoning) > 0 {
			var reasoningMap map[string]interface{}
			_ = json.Unmarshal(att.Reasoning, &reasoningMap)
			summary["reasoning"] = reasoningMap
		}
		summaries = append(summaries, summary)
	}

	return summaries, nil
}

// ── Outcome comparison ────────────────────────────────────────────────────────

// countErrorDiagnostics counts diagnostics with error severity (warnings and
// info are ignored — they don't block and shouldn't drive the repair verdict).
func countErrorDiagnostics(diags []*models.ValidationDiagnostic) int {
	n := 0
	for _, d := range diags {
		if d.Severity == "error" {
			n++
		}
	}
	return n
}

// failingStages returns the set of stages that have at least one error
// diagnostic. Used to detect a stage that regressed from passing → failing.
func failingStages(diags []*models.ValidationDiagnostic) map[string]struct{} {
	stages := map[string]struct{}{}
	for _, d := range diags {
		if d.Severity == "error" {
			stages[d.Stage] = struct{}{}
		}
	}
	return stages
}

// failingStageList returns the sorted names of stages that have at least one
// error diagnostic. Log-friendly variant of failingStages.
func failingStageList(diags []*models.ValidationDiagnostic) []string {
	set := failingStages(diags)
	out := make([]string, 0, len(set))
	for stage := range set {
		out = append(out, stage)
	}
	sort.Strings(out)
	return out
}

// diagnosticIdentity returns a stable string key for a diagnostic.
//
// The key deliberately EXCLUDES the line number: when a repair edits a file,
// line numbers of the remaining (unfixed) diagnostics shift, and a
// line-sensitive key would count the same logical error as both "resolved"
// (old line) and "introduced" (new line) — producing a spurious "regressed"
// outcome. Instead we key on stage/tool/category/severity/file plus a
// normalized message (digits and whitespace stripped) so a diagnostic keeps a
// stable identity across edits that only move it around.
//
// Key: stage : tool : category : severity : filePath : normalizedMessage
func diagnosticIdentity(d *models.ValidationDiagnostic) string {
	filePath := ""
	if d.FilePath != nil {
		filePath = *d.FilePath
	}
	return strings.Join([]string{
		d.Stage,
		d.Tool,
		d.Category,
		d.Severity,
		filePath,
		normalizeDiagnosticMessage(d.Message),
	}, ":")
}

// diagnosticDigits matches runs of digits (line/column numbers, counts) that
// vary between validation runs without changing the underlying problem.
var diagnosticDigits = regexp.MustCompile(`\d+`)

// diagnosticWhitespace collapses any whitespace run to a single space.
var diagnosticWhitespace = regexp.MustCompile(`\s+`)

// normalizeDiagnosticMessage makes a diagnostic message stable across edits:
// lower-cased, digit runs replaced with a placeholder, and whitespace
// collapsed. This keeps distinct errors distinct while ignoring positional
// noise like "line 42" vs "line 45".
func normalizeDiagnosticMessage(msg string) string {
	s := strings.ToLower(strings.TrimSpace(msg))
	s = diagnosticDigits.ReplaceAllString(s, "#")
	s = diagnosticWhitespace.ReplaceAllString(s, " ")
	return s
}

// compareValidationOutcomes determines the repair outcome by identity-based
// comparison of diagnostics between the before and after validation runs.
//
// Priority order:
//  1. after.OverallResult == "passed"            → "passed"
//  2. after.OverallResult == nil                 → "error"
//  3. after.OverallResult == "failed_environment" → "no_change" (env issue, not code)
//  4. after.OverallResult == "failed_requires_human" → "no_change" (cannot repair)
//  5. Error-count + stage-transition comparison:
//     - a stage that passed before but fails now → "regressed"
//     - fewer errors than before                 → "improved"
//     - more errors than before                  → "regressed"
//     - equal                                     → "no_change"
func (o *Orchestrator) compareValidationOutcomes(
	before, after *models.ValidationRun,
	log *zap.SugaredLogger,
) string {
	// Priority 1: explicit pass
	if after.OverallResult != nil && *after.OverallResult == "passed" {
		return "passed"
	}

	// Priority 2: nil overall_result is an unexpected state
	if after.OverallResult == nil {
		log.Warnw("compare_outcomes_nil_overall_result")
		return "error"
	}

	// Priority 3 & 4: environment or human-required failures
	switch *after.OverallResult {
	case "failed_environment":
		log.Debugw("compare_outcomes_failed_environment")
		return "no_change"
	case "failed_requires_human":
		log.Debugw("compare_outcomes_failed_requires_human")
		return "no_change"
	}

	// Build identity sets for before and after diagnostics
	beforeSet := map[string]struct{}{}
	for _, d := range before.Diagnostics {
		beforeSet[diagnosticIdentity(d)] = struct{}{}
	}

	afterSet := map[string]struct{}{}
	for _, d := range after.Diagnostics {
		afterSet[diagnosticIdentity(d)] = struct{}{}
	}

	// Count resolved (in before, not in after) and introduced (in after, not in before)
	resolved := 0
	for key := range beforeSet {
		if _, stillPresent := afterSet[key]; !stillPresent {
			resolved++
		}
	}
	introduced := 0
	for key := range afterSet {
		if _, wasThere := beforeSet[key]; !wasThere {
			introduced++
		}
	}

	// Error-count + stage-transition verdict. The identity sets above are kept
	// for observability, but the DECISION must not be "any new diagnostic id →
	// regressed": a single new/changed lint diagnostic would otherwise mask
	// fixing the build and tests. Instead:
	//   - a stage that PASSED before but fails now → genuine regression
	//   - otherwise judge by net error count (errors only, warnings ignored)
	beforeErrors := countErrorDiagnostics(before.Diagnostics)
	afterErrors := countErrorDiagnostics(after.Diagnostics)
	beforeFailing := failingStages(before.Diagnostics)
	afterFailing := failingStages(after.Diagnostics)

	var newlyFailing []string
	for stage := range afterFailing {
		if _, wasFailing := beforeFailing[stage]; !wasFailing {
			newlyFailing = append(newlyFailing, stage)
		}
	}

	log.Infow("comparing_validation_outcomes",
		"before_diagnostics", len(before.Diagnostics),
		"after_diagnostics", len(after.Diagnostics),
		"before_errors", beforeErrors,
		"after_errors", afterErrors,
		"resolved_identities", resolved,
		"introduced_identities", introduced,
		"newly_failing_stages", newlyFailing,
	)

	// A previously-passing stage that now fails means the repair broke
	// something that worked — a genuine regression regardless of net count.
	if len(newlyFailing) > 0 {
		return "regressed"
	}

	switch {
	case afterErrors < beforeErrors:
		return "improved"
	case afterErrors > beforeErrors:
		return "regressed"
	default:
		return "no_change"
	}
}
