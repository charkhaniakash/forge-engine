package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/ingestion"
	"github.com/charkhaniakash/forge-engine/backend/internal/models"
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
	execRepo   *repository.ExecutionRepository
	wsRepo     *repository.WorkspaceRepository
	wsManager  *workspace.WorkspaceManager
	agentClient *AgentExecClient
	publisher  EventPublisher
	jwtSecret  string
	logger     *zap.SugaredLogger
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

// Run executes an approved plan step-by-step. Called as a goroutine.
// It is the only place that advances task_executions.status.
func (o *ExecutionOrchestrator) Run(ctx context.Context, execID string, planBody json.RawMessage) {
	log := o.logger.With("exec_id", execID)

	exec, err := o.execRepo.GetExecution(ctx, execID)
	if err != nil {
		log.Errorw("exec_load_failed", "error", err)
		return
	}

	_ = o.execRepo.MarkRunning(ctx, execID)
	o.publishLifecycle(execID, "exec_start", "Execution started")

	// Resolve ordered steps from plan body, respecting depends_on.
	steps, err := resolveOrderedSteps(planBody)
	if err != nil {
		log.Errorw("resolve_steps_failed", "error", err)
		_ = o.execRepo.MarkFailed(ctx, execID, fmt.Sprintf("could not resolve plan steps: %v", err))
		return
	}

	// Resolve execution context from the stored JSONB.
	var execCtx models.ExecutionContext
	if err := json.Unmarshal(exec.ExecutionContext, &execCtx); err != nil {
		log.Errorw("exec_ctx_unmarshal_failed", "error", err)
		_ = o.execRepo.MarkFailed(ctx, execID, "invalid execution context")
		return
	}

	// Track artifacts across all steps for the final checkpoint.
	var modifiedFiles, createdFiles, deletedFiles []string

	for i, step := range steps {
		stableID, _ := step["stable_id"].(string)
		log = log.With("step", stableID, "step_num", i+1)

		// ── Control queue check ───────────────────────────────────────────────
		// Phase 7: only "cancel" is processed. Phase 12 adds "pause".
		if o.isCancelled(ctx, execID) {
			log.Infow("execution_cancelled_between_steps")
			_ = o.execRepo.MarkCancelled(ctx, execID)
			o.publishLifecycle(execID, "exec_cancelled", "Execution cancelled by user")
			return
		}

		// ── Create step_execution row ─────────────────────────────────────────
		order, _ := intFromStep(step, "order")
		stepExec, err := o.execRepo.CreateStepExecution(ctx, execID, stableID, order)
		if err != nil {
			log.Errorw("create_step_exec_failed", "error", err)
			_ = o.execRepo.MarkFailed(ctx, execID, fmt.Sprintf("db error: %v", err))
			return
		}

		_ = o.execRepo.UpdateCurrentStep(ctx, execID, stableID)
		_ = o.execRepo.MarkStepRunning(ctx, stepExec.ID)

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
			_ = o.execRepo.MarkStepFailed(ctx, stepExec.ID, err.Error())
			_ = o.execRepo.MarkFailed(ctx, execID, err.Error())
			return
		}

		// ── Call agent for THIS step only ─────────────────────────────────────
		stepCtxTimeout, cancel := context.WithTimeout(ctx, stepTimeout)
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
				o.handleStepEvent(ctx, execID, stepExec.ID, event,
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
			// Pipeline error or stream error — mark step as failed.
			errMsg := "execution pipeline error"
			if stepErr != nil {
				errMsg = stepErr.Error()
			}
			log.Errorw("step_execution_failed", "error", errMsg)
			_ = o.execRepo.MarkStepFailed(ctx, stepExec.ID, errMsg)
			_ = o.execRepo.MarkFailed(ctx, execID, fmt.Sprintf("step %s failed: %s", stableID, errMsg))
			return
		}
		if stepDeviation != "" {
			_ = o.execRepo.MarkStepDeviated(ctx, stepExec.ID, stepDeviation)
			o.publishLifecycle(execID, "deviation",
				fmt.Sprintf("Step %s deviated: %s", stableID, stepDeviation))
			// Deviation is not fatal — continue with remaining steps.
			// Phase 12 can add a gate here to pause for human review.
		} else {
			_ = o.execRepo.MarkStepCompleted(ctx, stepExec.ID, stepReasoning)
		}

		// ── Accumulate artifacts ──────────────────────────────────────────────
		modifiedFiles = appendUnique(modifiedFiles, stepModified...)
		createdFiles = appendUnique(createdFiles, stepCreated...)
		deletedFiles = appendUnique(deletedFiles, stepDeleted...)

		// ── Persist checkpoint after every step ───────────────────────────────
		_, _ = o.execRepo.SaveCheckpoint(ctx, execID, stableID, order,
			modifiedFiles, createdFiles, deletedFiles)

		log.Infow("step_completed", "step", stableID)
	}

	_ = o.execRepo.MarkCompleted(ctx, execID)
	o.publishLifecycle(execID, "exec_complete", fmt.Sprintf(
		"Execution complete — %d steps, %d files modified",
		len(steps), len(modifiedFiles),
	))
	log.Infow("execution_complete",
		"steps", len(steps),
		"modified", len(modifiedFiles))
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

	case "deviation":
		*deviation = event.Message
		_, _ = o.execRepo.AppendEvent(ctx, execID, stepExecIDPtr,
			"deviation", nil, nil, nil, nil, msgPtr, nil, nil)

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

// isCancelled checks the control queue for a cancel signal.
func (o *ExecutionOrchestrator) isCancelled(ctx context.Context, execID string) bool {
	// Phase 7: simple DB-level check — look for status=cancelled already set.
	exec, err := o.execRepo.GetExecution(ctx, execID)
	if err != nil {
		return false
	}
	return exec.Status == "cancelled"
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
