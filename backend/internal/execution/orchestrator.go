package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/llmcreds"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
	"github.com/charkhaniakash/forge-engine/backend/internal/pipeline"
	"github.com/charkhaniakash/forge-engine/backend/internal/repository"
	"github.com/charkhaniakash/forge-engine/backend/internal/workspace"
)

const (
	// controlQueueKey is the Redis key pattern for execution control signals.
	// Phase 7 only checks for "cancel". Phase 12 adds "pause".
	controlQueueKeyFmt = "forge:execution:%s:control"

	// stepTimeout is the maximum time allowed for one step's agent call.
	stepTimeout = 15 * time.Minute
)

// ValidationTrigger is a function the ExecutionOrchestrator calls to start
// validation automatically when execution completes. The call is non-blocking
// (fire-and-forget goroutine). This avoids a circular import between the
// execution and validation packages.
type ValidationTrigger func(ctx context.Context, taskExecutionID, workspaceID, traceID string)

// EventPublisher is a function that fans an execution event to the WebSocket hub.
// Keeping it as a function type keeps the orchestrator decoupled from the WS layer.
type EventPublisher func(taskExecutionID string, event ExecStreamEvent)

// ExecutionOrchestrator drives the step-by-step execution of an approved plan.
//
// Ownership contract:
//   - Go decides which step to run next (topological order + depends_on).
//   - Go calls the agent for ONE step at a time.
//   - Go persists every event, diff, and checkpoint.
//   - Go checks the control queue between every step.
//   - The agent is stateless; it never sees the full plan.
type ExecutionOrchestrator struct {
	execRepo          *repository.ExecutionRepository
	wsRepo            *repository.WorkspaceRepository
	wsManager         *workspace.WorkspaceManager
	agentClient       *AgentExecClient
	publisher         EventPublisher
	validationTrigger ValidationTrigger
	onStartHook       func(execID, workspaceID string)
	contextRegistry   *pipeline.ContextRegistry
	llm               *llmcreds.Service
	jwtSecret         string
	logger            *zap.SugaredLogger
}

// NewExecutionOrchestrator constructs an ExecutionOrchestrator.
func NewExecutionOrchestrator(
	execRepo *repository.ExecutionRepository,
	wsRepo *repository.WorkspaceRepository,
	wsManager *workspace.WorkspaceManager,
	agentClient *AgentExecClient,
	publisher EventPublisher,
	jwtSecret string,
	logger *zap.SugaredLogger,
) *ExecutionOrchestrator {
	return &ExecutionOrchestrator{
		execRepo:    execRepo,
		wsRepo:      wsRepo,
		wsManager:   wsManager,
		agentClient: agentClient,
		publisher:   publisher,
		jwtSecret:   jwtSecret,
		logger:      logger,
	}
}

// SetPublisher wires the WebSocket publisher after construction.
// Called by NewExecutionHandlers to avoid an import cycle.
func (o *ExecutionOrchestrator) SetPublisher(pub EventPublisher) {
	o.publisher = pub
}

// GetPublisher returns the current publisher (used by event bridges to wrap it).
func (o *ExecutionOrchestrator) GetPublisher() EventPublisher {
	return o.publisher
}

// SetOnStartHook registers a callback invoked when execution begins.
// Used by Phase 10B EventBridge to register the execution→workspace mapping.
func (o *ExecutionOrchestrator) SetOnStartHook(hook func(execID, workspaceID string)) {
	o.onStartHook = hook
}

// SetValidationTrigger wires the automatic post-execution validation trigger.
// Called by NewExecutionHandlers after both orchestrators are constructed.
func (o *ExecutionOrchestrator) SetValidationTrigger(trigger ValidationTrigger) {
	o.validationTrigger = trigger
}

// SetContextRegistry wires the pipeline context registry for cancellation propagation.
// When set, the Run method registers a cancellable context for each execution,
// enabling Stop to immediately cancel in-flight operations across all pipeline phases.
func (o *ExecutionOrchestrator) SetContextRegistry(cr *pipeline.ContextRegistry) {
	o.contextRegistry = cr
}

func (o *ExecutionOrchestrator) SetLLM(svc *llmcreds.Service) {
	o.llm = svc
}

// Run executes an approved plan step-by-step. Called as a goroutine.
// It is the only place that advances task_executions.status.
func (o *ExecutionOrchestrator) Run(ctx context.Context, execID string, planBody json.RawMessage) {
	log := o.logger.With("exec_id", execID)

	// ── Register a cancellable pipeline context ───────────────────────────────
	// When contextRegistry is set, create a cancellable context keyed by execID.
	// Stop calls cancel this context, immediately terminating in-flight operations.
	// Fall back to the provided ctx if no registry is configured.
	//
	// The entry must outlive Run when validation/repair run as a spawned goroutine
	// (below): Run returns as soon as it launches that goroutine, so deregistering
	// here would drop the entry while the pipeline is still active and make
	// Cancel(execID) a no-op during validation/repair. We therefore only
	// deregister here on the paths that DON'T hand off to the trigger goroutine;
	// when we do hand off, that goroutine owns deregistration.
	pipelineCtx := ctx
	triggerSpawned := false
	if o.contextRegistry != nil {
		pipelineCtx = o.contextRegistry.Register(context.Background(), execID)
		defer func() {
			if !triggerSpawned {
				o.contextRegistry.Deregister(execID)
			}
		}()
	}

	exec, err := o.execRepo.GetExecution(pipelineCtx, execID)
	if err != nil {
		log.Errorw("exec_load_failed", "error", err)
		return
	}

	// Fire start hook (used by Phase 10B EventBridge to register workspace mapping)
	if o.onStartHook != nil {
		o.onStartHook(execID, exec.WorkspaceID)
	}

	_ = o.execRepo.MarkRunning(pipelineCtx, execID)
	o.publishLifecycle(execID, "exec_start", "Execution started")

	// Resolve ordered steps from plan body, respecting depends_on.
	steps, err := resolveOrderedSteps(planBody)
	if err != nil {
		log.Errorw("resolve_steps_failed", "error", err)
		_ = o.execRepo.MarkFailed(pipelineCtx, execID, fmt.Sprintf("could not resolve plan steps: %v", err))
		return
	}

	// Resolve execution context from the stored JSONB.
	var execCtx models.ExecutionContext
	if err := json.Unmarshal(exec.ExecutionContext, &execCtx); err != nil {
		log.Errorw("exec_ctx_unmarshal_failed", "error", err)
		_ = o.execRepo.MarkFailed(pipelineCtx, execID, "invalid execution context")
		return
	}

	if o.llm != nil && execCtx.OrgID != "" {
		bound, bindErr := o.llm.BindActive(pipelineCtx, execCtx.OrgID)
		if bindErr != nil {
			log.Errorw("llm_bind_failed", "error", bindErr)
			_ = o.execRepo.MarkFailed(pipelineCtx, execID, bindErr.Error())
			return
		}
		pipelineCtx = bound
	}

	// Track artifacts across all steps for the final checkpoint.
	var modifiedFiles, createdFiles, deletedFiles []string

	// deviatedOrFailed tracks stable_ids of steps that deviated or failed.
	// Any step whose depends_on contains a deviated/failed step is skipped.
	deviatedOrFailed := map[string]bool{}

	for i, step := range steps {
		stableID, _ := step["stable_id"].(string)
		log = log.With("step", stableID, "step_num", i+1)

		// ── Control queue check ───────────────────────────────────────────────
		if o.isCancelled(pipelineCtx, execID) {
			log.Infow("execution_cancelled_between_steps")
			_ = o.execRepo.MarkCancelled(pipelineCtx, execID)
			o.publishLifecycle(execID, "exec_cancelled", "Execution cancelled by user")
			return
		}

		// ── Pause check ───────────────────────────────────────────────────────
		// If the user paused, block here (between steps) until they resume or
		// cancel. waitForResume polls the execution status.
		if o.isPaused(pipelineCtx, execID) {
			log.Infow("execution_paused_between_steps")
			o.publishLifecycle(execID, "exec_paused", "Execution paused by user")
			if cancelled := o.waitForResume(pipelineCtx, execID); cancelled {
				log.Infow("execution_cancelled_while_paused")
				_ = o.execRepo.MarkCancelled(pipelineCtx, execID)
				o.publishLifecycle(execID, "exec_cancelled", "Execution cancelled by user")
				return
			}
			log.Infow("execution_resumed")
			o.publishLifecycle(execID, "exec_resumed", "Execution resumed")
		}

		// ── Dependency skip check ─────────────────────────────────────────────
		// If any prerequisite step deviated or failed, skip this step rather
		// than executing it and producing a meaningless deviation.
		order, _ := intFromStep(step, "order")
		if blockedBy := o.findBlockingDep(step, deviatedOrFailed); blockedBy != "" {
			log.Infow("step_skipped_blocked_dep",
				"step", stableID, "blocked_by", blockedBy)
			stepExec, err := o.execRepo.CreateStepExecution(pipelineCtx, execID, stableID, order)
			if err == nil {
				skipNote := fmt.Sprintf("skipped: dependency '%s' deviated or failed", blockedBy)
				_ = o.execRepo.MarkStepSkipped(pipelineCtx, stepExec.ID, skipNote)
				o.publishLifecycle(execID, "step_skipped", fmt.Sprintf(
					"Step %s skipped — dependency '%s' did not complete", stableID, blockedBy))
			}
			// Propagate: this step is also blocked for downstream steps.
			deviatedOrFailed[stableID] = true
			continue
		}
		stepExec, err := o.execRepo.CreateStepExecution(pipelineCtx, execID, stableID, order)
		if err != nil {
			log.Errorw("create_step_exec_failed", "error", err)
			_ = o.execRepo.MarkFailed(pipelineCtx, execID, fmt.Sprintf("db error: %v", err))
			return
		}

		_ = o.execRepo.UpdateCurrentStep(pipelineCtx, execID, stableID)
		_ = o.execRepo.MarkStepRunning(pipelineCtx, stepExec.ID)

		// ── Inject step_id and step_execution_id into execution context ─────────
		stepCtx := execCtx
		stepCtx.StepID = stableID
		stepCtx.StepExecutionID = stepExec.ID

		// ── Sign agent token ──────────────────────────────────────────────────
		agentToken, err := ingestion.SignJWT(map[string]interface{}{
			"sub":          "backend",
			"exec_id":      execID,
			"step_id":      stableID,
			"iat":          time.Now().Unix(),
			"exp":          time.Now().Add(stepTimeout).Unix(),
		}, o.jwtSecret)
		if err != nil {
			log.Errorw("sign_agent_token_failed", "error", err)
			_ = o.execRepo.MarkStepFailed(pipelineCtx, stepExec.ID, err.Error())
			_ = o.execRepo.MarkFailed(pipelineCtx, execID, err.Error())
			return
		}

		// ── Call agent for THIS step only ─────────────────────────────────────
		stepCtxTimeout, cancel := context.WithTimeout(pipelineCtx, stepTimeout)
		stepCtxTimeout = ingestion.WithTraceID(stepCtxTimeout, execCtx.TraceID)

		req := StepRequest{
			Version:         1,
			ExecutionContext: stepCtx,
			Step:            step,
			RequestID:       fmt.Sprintf("step-%s-%s", execID[:8], stableID),
		}

		var stepReasoning string
		var stepDeviation string
		var stepModified, stepCreated, stepDeleted []string
		var stepErr error
		var pipelineError bool

		streamErr := o.agentClient.ExecuteStep(stepCtxTimeout, req, agentToken,
			func(event ExecStreamEvent) {
				// Track if the pipeline emitted an error event.
				if event.Event == "error" {
					pipelineError = true
				}
				o.handleStepEvent(pipelineCtx, execID, stepExec.ID, event,
					&stepReasoning, &stepDeviation,
					&stepModified, &stepCreated, &stepDeleted)
				// Fan to WebSocket.
				if o.publisher != nil {
					o.publisher(execID, event)
				}
			})

		cancel()

		if streamErr != nil {
			stepErr = streamErr
		}
		if pipelineError || stepErr != nil {
			errMsg := "execution pipeline error"
			if stepErr != nil {
				errMsg = stepErr.Error()
			}
			log.Errorw("step_execution_failed", "error", errMsg)
			_ = o.execRepo.MarkStepFailed(pipelineCtx, stepExec.ID, errMsg)
			_ = o.execRepo.MarkFailed(pipelineCtx, execID, fmt.Sprintf("step %s failed: %s", stableID, errMsg))
			return
		}
		if stepDeviation != "" {
			// Classify the deviation type for the step record.
			if strings.HasPrefix(stepDeviation, "execution_error:") {
				_ = o.execRepo.MarkStepFailed(pipelineCtx, stepExec.ID,
					strings.TrimPrefix(stepDeviation, "execution_error: "))
				o.publishLifecycle(execID, "execution_error",
					fmt.Sprintf("Step %s: %s", stableID, stepDeviation))
				deviatedOrFailed[stableID] = true
			} else if strings.HasPrefix(stepDeviation, "requires_human:") {
				_ = o.execRepo.MarkStepDeviated(pipelineCtx, stepExec.ID, stepDeviation)
				o.publishLifecycle(execID, "requires_human",
					fmt.Sprintf("Step %s requires human input: %s",
						stableID, strings.TrimPrefix(stepDeviation, "requires_human: ")))
				deviatedOrFailed[stableID] = true
			} else if strings.HasPrefix(stepDeviation, "already_satisfied:") {
				// Already satisfied - no changes needed, don't block downstream
				_ = o.execRepo.MarkStepCompleted(pipelineCtx, stepExec.ID, stepReasoning)
				o.publishLifecycle(execID, "already_satisfied",
					fmt.Sprintf("Step %s already satisfied: %s",
						stableID, strings.TrimPrefix(stepDeviation, "already_satisfied: ")))
				// Do NOT mark as deviatedOrFailed - allow downstream to continue
			} else {
				// plan_deviation (including legacy deviation events)
				_ = o.execRepo.MarkStepDeviated(pipelineCtx, stepExec.ID, stepDeviation)
				o.publishLifecycle(execID, "plan_deviation",
					fmt.Sprintf("Step %s: %s", stableID, stepDeviation))
				deviatedOrFailed[stableID] = true
			}
		} else {
			_ = o.execRepo.MarkStepCompleted(pipelineCtx, stepExec.ID, stepReasoning)
		}

		// ── Accumulate artifacts ──────────────────────────────────────────────
		modifiedFiles = appendUnique(modifiedFiles, stepModified...)
		createdFiles = appendUnique(createdFiles, stepCreated...)
		deletedFiles = appendUnique(deletedFiles, stepDeleted...)

		// ── Persist checkpoint after every step ───────────────────────────────
		_, _ = o.execRepo.SaveCheckpoint(pipelineCtx, execID, stableID, order,
			modifiedFiles, createdFiles, deletedFiles)

		log.Infow("step_completed", "step", stableID)
	}

	// Determine the accurate final status based on what actually happened.
	// "completed" means every step succeeded.
	// "completed_with_deviations" means we finished but some steps deviated/skipped.
	// "failed" is reserved for hard infrastructure failures (handled above with early return).
	hasDeviations := len(deviatedOrFailed) > 0
	completedSteps := 0
	skippedSteps := 0
	deviatedSteps := 0
	for _, step := range steps {
		sid, _ := step["stable_id"].(string)
		if deviatedOrFailed[sid] {
			// Count deviations vs skips from the step records.
			deviatedSteps++
		} else {
			completedSteps++
		}
	}
	// Separate skipped from deviated using the execRepo.
	stepExecs, _ := o.execRepo.ListStepExecutions(pipelineCtx, execID)
	for _, se := range stepExecs {
		if se.Status == "skipped" {
			skippedSteps++
			deviatedSteps-- // it was counted above as deviated, correct the count
		}
	}

	var finalStatus, finalMsg string
	if hasDeviations {
		finalStatus = "completed_with_deviations"
		// Build a human-readable reason list for the UI so users don't need
		// to open a separate page to understand what happened.
		var reasons []string
		stepExecsMap := map[string]*models.StepExecution{}
		for _, se := range stepExecs {
			stepExecsMap[se.StepStableID] = se
		}
		for _, step := range steps {
			sid, _ := step["stable_id"].(string)
			if !deviatedOrFailed[sid] {
				continue
			}
			se, ok := stepExecsMap[sid]
			if !ok {
				continue
			}
			switch se.Status {
			case "deviated":
				note := ""
				if se.DeviationNote != nil {
					note = *se.DeviationNote
					if len(note) > 120 {
						note = note[:120] + "…"
					}
				}
				reasons = append(reasons, fmt.Sprintf("Step '%s' deviated: %s", sid, note))
			case "failed":
				note := ""
				if se.DeviationNote != nil {
					note = *se.DeviationNote
					if len(note) > 120 {
						note = note[:120] + "…"
					}
				}
				reasons = append(reasons, fmt.Sprintf("Step '%s' failed: %s", sid, note))
			case "skipped":
				reasons = append(reasons, fmt.Sprintf("Step '%s' skipped (dependency failed)", sid))
			}
		}
		reasonStr := strings.Join(reasons, "; ")
		if reasonStr == "" {
			reasonStr = "one or more steps did not complete successfully"
		}
		finalMsg = fmt.Sprintf(
			"Execution complete with deviations — %d/%d steps completed, %d deviated, %d skipped, %d files modified. Reason: %s",
			completedSteps, len(steps), deviatedSteps, skippedSteps, len(modifiedFiles), reasonStr,
		)
	} else {
		finalStatus = "completed"
		finalMsg = fmt.Sprintf(
			"Execution complete — %d/%d steps completed, %d files modified",
			completedSteps, len(steps), len(modifiedFiles),
		)
	}

	if err := o.execRepo.MarkCompletedWithStatus(pipelineCtx, execID, finalStatus); err != nil {
		log.Errorw("mark_completed_failed", "error", err)
	}

	o.publishLifecycle(execID, "exec_complete", finalMsg)
	log.Infow("execution_complete",
		"status", finalStatus,
		"steps_total", len(steps),
		"steps_completed", completedSteps,
		"steps_deviated", deviatedSteps,
		"steps_skipped", skippedSteps,
		"modified", len(modifiedFiles))

	// ── Automatic validation trigger ──────────────────────────────────────────
	// Validation is part of the execution pipeline, not a user action.
	// We trigger it automatically after every execution (completed or
	// completed_with_deviations). Failed executions (hard infrastructure
	// errors) skip validation because the workspace state is unreliable.
	if o.validationTrigger != nil && (finalStatus == "completed" || finalStatus == "completed_with_deviations") {
		o.publishLifecycle(execID, "validation_queued", "Execution complete — starting automatic validation")
		log.Infow("auto_validation_triggered", "exec_id", execID)
		// The trigger goroutine owns the pipeline context for the remaining phases
		// (validation → repair → publishing), so it must deregister the entry when
		// it finishes — including on panic. Deregistering in Run (above) is skipped
		// via triggerSpawned so the entry stays live for Cancel(execID) to reach.
		triggerSpawned = true
		trigger := o.validationTrigger
		cr := o.contextRegistry
		go func() {
			if cr != nil {
				defer cr.Deregister(execID)
			}
			trigger(pipelineCtx, execID, execCtx.WorkspaceID, execCtx.TraceID)
		}()
	}
}

// handleStepEvent processes one event from the agent and persists it.
func (o *ExecutionOrchestrator) handleStepEvent(
	ctx context.Context,
	execID, stepExecID string,
	event ExecStreamEvent,
	reasoning, deviation *string,
	modified, created, deleted *[]string,
) {
	stepExecIDPtr := &stepExecID
	msg := event.Message
	msgPtr := &msg

	switch event.Event {
	case "reasoning":
		if *reasoning != "" {
			*reasoning += "\n"
		}
		*reasoning += event.Message
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"reasoning", nil, nil, nil, nil, msgPtr, nil, nil)

	case "tool_call":
		toolName := event.ToolName
		callID := event.ToolCallID
		callIDPtr := &callID
		if callID == "" {
			callIDPtr = nil
		}
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"tool_call", &toolName, event.ToolArgs, nil, callIDPtr, nil, nil, nil)

	case "tool_result":
		toolName := event.ToolName
		success := event.Success
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"tool_result", &toolName, nil, event.ToolResult, nil, nil, &success, nil)

		// Track file artifacts from write/create/delete/rename results.
		o.trackArtifact(event, modified, created, deleted)

	case "deviation", "plan_deviation":
		// "deviation" is the legacy event type; "plan_deviation" is the typed form.
		// Both set the deviation field. Go surfaces this to the user and may
		// trigger replanning in Phase 9.
		*deviation = event.Message
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"plan_deviation", nil, nil, nil, nil, msgPtr, nil, nil)

	case "requires_human":
		// The step needs human input — block execution here.
		// Phase 12 will add the actual gate; for now surface it as a deviation.
		*deviation = "requires_human: " + event.Message
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"requires_human", nil, nil, nil, nil, msgPtr, nil, nil)

	case "execution_error":
		// Technical failure inside the agent — different from plan mismatch.
		// Surfaced as a step failure so Go can retry or escalate.
		*deviation = "execution_error: " + event.Message
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"execution_error", nil, nil, nil, nil, msgPtr, nil, nil)

	case "step_complete":
		if event.Summary != "" {
			*reasoning = event.Summary
		}
	}
}

// trackArtifact updates modified/created/deleted file lists from tool results.
func (o *ExecutionOrchestrator) trackArtifact(
	event ExecStreamEvent,
	modified, created, deleted *[]string,
) {
	switch event.ToolName {
	case "write_file":
		var args map[string]interface{}
		if json.Unmarshal(event.ToolArgs, &args) == nil {
			if path, ok := args["path"].(string); ok {
				*modified = appendUnique(*modified, normalizeWorkspacePath(path))
			}
		}
	case "create_file":
		var args map[string]interface{}
		if json.Unmarshal(event.ToolArgs, &args) == nil {
			if path, ok := args["path"].(string); ok {
				*created = appendUnique(*created, normalizeWorkspacePath(path))
			}
		}
	case "delete_file":
		var args map[string]interface{}
		if json.Unmarshal(event.ToolArgs, &args) == nil {
			if path, ok := args["path"].(string); ok {
				*deleted = appendUnique(*deleted, normalizeWorkspacePath(path))
			}
		}
	}
}

// findBlockingDep returns the stable_id of the first dependency that is in
// deviatedOrFailed, or "" if all dependencies passed.
// Each step in the ordered list has a "_dep_stable_ids" annotation injected
// by resolveOrderedSteps — a []string of the resolved stable_ids for depends_on.
func (o *ExecutionOrchestrator) findBlockingDep(
	step map[string]interface{},
	deviatedOrFailed map[string]bool,
) string {
	deps := extractStringSlice(step["_dep_stable_ids"])
	for _, depStableID := range deps {
		if deviatedOrFailed[depStableID] {
			return depStableID
		}
	}
	return ""
}
func (o *ExecutionOrchestrator) isCancelled(ctx context.Context, execID string) bool {
	// Phase 7: simple DB-level check — look for status=cancelled already set.
	exec, err := o.execRepo.GetExecution(ctx, execID)
	if err != nil {
		return false
	}
	return exec.Status == "cancelled"
}

// isPaused checks whether the execution has been paused by a user.
func (o *ExecutionOrchestrator) isPaused(ctx context.Context, execID string) bool {
	exec, err := o.execRepo.GetExecution(ctx, execID)
	if err != nil {
		return false
	}
	return exec.Status == "paused"
}

// waitForResume blocks until a paused execution is resumed or cancelled.
// Called between steps when isPaused returns true.
func (o *ExecutionOrchestrator) waitForResume(ctx context.Context, execID string) (cancelled bool) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return true
		}
		if o.isCancelled(ctx, execID) {
			return true
		}
		if !o.isPaused(ctx, execID) {
			return false
		}
		<-ticker.C
	}
}

// publishLifecycle sends a synthetic lifecycle event to the WebSocket hub.
func (o *ExecutionOrchestrator) publishLifecycle(execID, eventType, message string) {
	if o.publisher != nil {
		o.publisher(execID, ExecStreamEvent{
			Version:   1,
			Event:     eventType,
			RequestID: execID,
			Message:   message,
		})
	}
}

// resolveOrderedSteps extracts plan steps in topological order (respecting depends_on).
// Phase 7 executes sequentially; Phase 14 can parallelise independent branches.
func resolveOrderedSteps(planBody json.RawMessage) ([]map[string]interface{}, error) {
	var plan map[string]interface{}
	if err := json.Unmarshal(planBody, &plan); err != nil {
		return nil, err
	}

	stepsRaw, ok := plan["steps"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("plan has no steps array")
	}

	steps := make([]map[string]interface{}, 0, len(stepsRaw))
	for _, s := range stepsRaw {
		if sm, ok := s.(map[string]interface{}); ok {
			steps = append(steps, sm)
		}
	}

	// Build a mapping from step ID to stable_id for dependency resolution.
	// The depends_on field uses step IDs (UUIDs), not stable_ids.
	idToStableID := make(map[string]string)
	for _, step := range steps {
		if id, ok := step["id"].(string); ok {
			if stableID, ok := step["stable_id"].(string); ok {
				idToStableID[id] = stableID
			}
		}
	}

	// Topological sort: process steps with no unmet dependencies first.
	// Phase 7: the plan validator already guarantees no cycles, so a simple
	// Kahn's algorithm is sufficient.
	done := map[string]bool{}
	var ordered []map[string]interface{}

	for len(ordered) < len(steps) {
		progress := false
		for _, step := range steps {
			sid, _ := step["stable_id"].(string)
			if done[sid] {
				continue
			}
			// Check all deps are done. deps are step IDs, so we need to map them to stable_ids.
			deps := extractStringSlice(step["depends_on"])
			ready := true
			for _, depID := range deps {
				depStableID, exists := idToStableID[depID]
				if !exists {
					// If the dependency ID doesn't exist in the plan, skip it (might be a deleted step).
					continue
				}
				if !done[depStableID] {
					ready = false
					break
				}
			}
			if ready {
				// Annotate the step with resolved dependency stable_ids so the
				// Run loop can check them against deviatedOrFailed without
				// re-resolving the UUID→stable_id mapping.
				depStableIDs := make([]interface{}, 0)
				for _, depID := range deps {
					if ds, ok := idToStableID[depID]; ok {
						depStableIDs = append(depStableIDs, ds)
					}
				}
				step["_dep_stable_ids"] = depStableIDs
				ordered = append(ordered, step)
				done[sid] = true
				progress = true
			}
		}
		if !progress {
			return nil, fmt.Errorf("dependency cycle detected in plan steps")
		}
	}

	return ordered, nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func intFromStep(step map[string]interface{}, key string) (int, bool) {
	v, ok := step[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func extractStringSlice(v interface{}) []string {
	if v == nil {
		return nil
	}
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func appendUnique(slice []string, items ...string) []string {
	seen := map[string]bool{}
	for _, s := range slice {
		seen[s] = true
	}
	for _, s := range items {
		if !seen[s] {
			slice = append(slice, s)
			seen[s] = true
		}
	}
	return slice
}

func normalizeWorkspacePath(p string) string {
	p = strings.TrimPrefix(p, "/workspace/")
	p = strings.TrimPrefix(p, "/workspace")
	return p
}
