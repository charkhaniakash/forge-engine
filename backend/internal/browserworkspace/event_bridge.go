package browserworkspace

import (
	"encoding/json"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
)

// EventBridge forwards events from existing orchestrators (execution, validation,
// repair, publishing) into the unified workspace gateway so that browser clients
// see AI activity, timeline events, and diagnostics in real-time.
//
// Design: Each wrapper binds the workspaceID at creation time. The caller (main.go)
// knows the workspaceID when constructing the closure, so we avoid any runtime lookup.
// All wrappers follow the same pattern:
//   1. Call the original publisher (preserves existing per-phase WebSocket behavior)
//   2. Forward to the browser workspace gateway (adds unified browser stream)
//
// Event lifecycle contract for every phase:
//   phase_started → progress events → phase_completed | phase_failed
type EventBridge struct {
	gateway            *Gateway
	executionWorkspaces map[string]string // taskExecutionID → workspaceID
	logger             *zap.SugaredLogger
}

// NewEventBridge creates an event bridge.
func NewEventBridge(gateway *Gateway, logger *zap.SugaredLogger) *EventBridge {
	return &EventBridge{
		gateway:            gateway,
		executionWorkspaces: make(map[string]string),
		logger:             logger,
	}
}

// RegisterExecution maps a task execution ID to its workspace ID.
// Called when execution starts so the execution publisher can resolve workspace.
func (eb *EventBridge) RegisterExecution(taskExecutionID, workspaceID string) {
	eb.executionWorkspaces[taskExecutionID] = workspaceID
}

// UnregisterExecution removes the mapping when execution completes.
func (eb *EventBridge) UnregisterExecution(taskExecutionID string) {
	delete(eb.executionWorkspaces, taskExecutionID)
}

// ── Execution (Phase 7) ─────────────────────────────────────────────────────

// WrapExecutionPublisher returns a new EventPublisher that forwards execution
// events to the browser workspace gateway IN ADDITION to calling the original.
//
// Unlike other wrappers, this does NOT bind workspaceID at creation time because
// the execution publisher is set once globally. Instead it uses two mechanisms:
// 1. Self-registration: the execution handler calls RegisterExecution() before starting
// 2. The validation trigger closure also calls RegisterExecution() as a safety net
func (eb *EventBridge) WrapExecutionPublisher(
	original execution.EventPublisher,
) execution.EventPublisher {
	return func(taskExecutionID string, event execution.ExecStreamEvent) {
		// 1. Call original (sends to per-task execution WebSocket)
		if original != nil {
			original(taskExecutionID, event)
		}

		// 2. Resolve workspace ID from registry
		workspaceID, ok := eb.executionWorkspaces[taskExecutionID]
		if !ok || workspaceID == "" {
			// Not registered yet — skip (common for the first few events
			// before the handler registers it; they'll be in the existing WS stream anyway)
			return
		}

		// 3. Forward to browser workspace gateway
		switch event.Event {
		// ── Lifecycle ──
		case "exec_start":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":   "executing",
				"message": event.Message,
			})
			eb.gateway.Publish(workspaceID, ChAIActivity, "phase_started", map[string]interface{}{
				"phase": "executing",
			})

		case "exec_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "executing",
				"status": "success",
			})

		case "exec_cancelled":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "executing",
				"status": "cancelled",
			})

		case "execution_error", "error":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":   "executing",
				"status":  "failed",
				"message": event.Message,
			})
			eb.gateway.Publish(workspaceID, ChAIActivity, "error", map[string]interface{}{
				"message": event.Message,
			})

		// ── Step progress ──
		case "step_started":
			eb.gateway.Publish(workspaceID, ChTimeline, "step_started", map[string]interface{}{
				"phase": "executing",
				"step":  event.StepID,
			})

		case "step_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":   "executing",
				"step":    event.StepID,
				"status":  "success",
				"message": event.Summary,
			})
			// Notify browser that workspace files changed
			eb.gateway.Publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason":         "step_complete",
				"modified_files": event.ModifiedFiles,
			})

		case "step_skipped":
			eb.gateway.Publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":  "executing",
				"step":   event.StepID,
				"status": "skipped",
			})

		// ── AI reasoning activity ──
		case "reasoning":
			eb.gateway.Publish(workspaceID, ChAIActivity, "reasoning", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "tool_call":
			eb.gateway.Publish(workspaceID, ChAIActivity, "tool_call", map[string]interface{}{
				"tool":         event.ToolName,
				"args":         event.ToolArgs,
				"tool_call_id": event.ToolCallID,
				"step":         event.StepID,
			})

		case "tool_result":
			eb.gateway.Publish(workspaceID, ChAIActivity, "tool_result", map[string]interface{}{
				"tool":         event.ToolName,
				"success":      event.Success,
				"tool_call_id": event.ToolCallID,
				"step":         event.StepID,
			})
			// Emit precise file change events for write/create/delete tools
			if event.Success {
				filePath := extractPathFromArgs(event.ToolArgs)
				switch event.ToolName {
				case "write_file":
					if filePath != "" {
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_modified", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
					}
				case "create_file":
					if filePath != "" {
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_created", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
					}
				case "delete_file":
					if filePath != "" {
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_deleted", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
					}
				case "rename_file":
					if filePath != "" {
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_renamed", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
					}
				}
			}

		// ── Deviations ──
		case "plan_deviation", "deviation":
			eb.gateway.Publish(workspaceID, ChAIActivity, "deviation", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "requires_human":
			eb.gateway.Publish(workspaceID, ChAIActivity, "requires_human", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})
			eb.gateway.Publish(workspaceID, ChCollaboration, "requires_human", map[string]interface{}{
				"message": event.Message,
			})

		case "already_satisfied":
			eb.gateway.Publish(workspaceID, ChAIActivity, "already_satisfied", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "validation_queued":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":   "validation",
				"message": "Automatic validation starting",
			})
		}
	}
}

// ── Validation (Phase 8) ────────────────────────────────────────────────────

// WrapValidationPublisher returns a function that forwards validation events
// to the browser workspace gateway. The validation orchestrator doesn't use
// a typed publisher interface — it publishes directly to its own WebSocket hub.
// This wrapper is called from the validation trigger closure in main.go.
//
// Lifecycle: validation_start → stage_start/complete → validation_complete
func (eb *EventBridge) WrapValidationPublisher(workspaceID string) func(event string, payload map[string]interface{}) {
	return func(event string, payload map[string]interface{}) {
		switch event {
		case "validation_start":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":   "validation",
				"status":  "running",
				"stack":   payload["stack"],
				"profile": payload["profile"],
			})
			eb.gateway.Publish(workspaceID, ChDiagnostics, "run_started", payload)

		case "stage_start":
			eb.gateway.Publish(workspaceID, ChDiagnostics, "stage_started", payload)
			eb.gateway.Publish(workspaceID, ChAIActivity, "validation_stage", map[string]interface{}{
				"stage":  payload["stage"],
				"status": "running",
			})

		case "stage_complete":
			eb.gateway.Publish(workspaceID, ChDiagnostics, "stage_completed", payload)
			eb.gateway.Publish(workspaceID, ChAIActivity, "validation_stage", map[string]interface{}{
				"stage":  payload["stage"],
				"status": "completed",
				"passed": payload["passed"],
			})

		case "stage_output":
			eb.gateway.Publish(workspaceID, ChDiagnostics, "stage_output", payload)

		case "stage_diagnostics":
			eb.gateway.Publish(workspaceID, ChDiagnostics, "items_added", payload)

		case "stage_skipped":
			eb.gateway.Publish(workspaceID, ChDiagnostics, "stage_skipped", payload)

		case "validation_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":   "validation",
				"status":  "completed",
				"overall": payload["overall"],
			})
			eb.gateway.Publish(workspaceID, ChDiagnostics, "run_completed", payload)
		}
	}
}

// ── Repair (Phase 9) ────────────────────────────────────────────────────────

// WrapRepairPublisher wraps the repair orchestrator's publish function to also
// forward events to the browser workspace gateway.
//
// Lifecycle: repair_started → attempt_started → reasoning/tool events → attempt_complete → repair_complete|repair_escalated
func (eb *EventBridge) WrapRepairPublisher(
	original func(sessionID, eventType string, payload map[string]interface{}),
	workspaceID string,
) func(sessionID, eventType string, payload map[string]interface{}) {
	return func(sessionID, eventType string, payload map[string]interface{}) {
		// 1. Call original (sends to per-session repair WebSocket)
		if original != nil {
			original(sessionID, eventType, payload)
		}

		// 2. Forward to browser workspace gateway
		switch eventType {
		// ── Lifecycle ──
		case "repair_started":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":        "repair",
				"status":       "running",
				"max_attempts": payload["max_attempts"],
			})
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_started", payload)

		case "repair_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":        "repair",
				"status":       "success",
				"final_result": payload["final_result"],
			})
			eb.gateway.Publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason": "repair_complete",
			})

		case "repair_escalated":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "repair",
				"status": "failed",
				"reason": payload["reason"],
			})

		// ── Attempt progress ──
		case "attempt_started":
			eb.gateway.Publish(workspaceID, ChTimeline, "step_started", map[string]interface{}{
				"phase":          "repair",
				"attempt_number": payload["attempt_number"],
			})
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_attempt_started", payload)

		case "attempt_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":          "repair",
				"status":         "completed",
				"attempt_number": payload["attempt_number"],
				"outcome":        payload["outcome"],
			})
			// Files changed during repair attempt
			eb.gateway.Publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason":         "repair_attempt_complete",
				"modified_files": payload["modified_files"],
			})

		case "attempt_reasoning":
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_strategy", map[string]interface{}{
				"strategy":   payload["strategy"],
				"confidence": payload["confidence"],
				"summary":    payload["summary"],
			})

		// ── AI reasoning activity ──
		case "reasoning":
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_reasoning", map[string]interface{}{
				"message":        payload["message"],
				"attempt_number": payload["attempt_number"],
			})

		case "tool_call":
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_tool_call", map[string]interface{}{
				"tool":           payload["tool"],
				"tool_call_id":   payload["tool_call_id"],
				"attempt_number": payload["attempt_number"],
			})

		case "tool_result":
			eb.gateway.Publish(workspaceID, ChAIActivity, "repair_tool_result", map[string]interface{}{
				"tool":           payload["tool"],
				"success":        payload["success"],
				"tool_call_id":   payload["tool_call_id"],
				"attempt_number": payload["attempt_number"],
			})
			// Emit precise file change events for repair writes
			if success, ok := payload["success"].(bool); ok && success {
				if tool, ok := payload["tool"].(string); ok {
					switch tool {
					case "write_file":
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_modified", map[string]interface{}{
							"source": "repair",
						})
					case "create_file":
						eb.gateway.Publish(workspaceID, ChFilesystem, "file_created", map[string]interface{}{
							"source": "repair",
						})
					}
				}
			}
		}
	}
}

// ── Publishing (Phase 10) ───────────────────────────────────────────────────

// WrapPublishingPublisher wraps the publishing orchestrator's publish function
// to forward events to the browser workspace gateway.
//
// Lifecycle: publishing_started → step progress → publishing_complete
func (eb *EventBridge) WrapPublishingPublisher(
	original func(sessionID, eventType string, payload map[string]interface{}),
	workspaceID string,
) func(sessionID, eventType string, payload map[string]interface{}) {
	return func(sessionID, eventType string, payload map[string]interface{}) {
		// 1. Call original (sends to per-session publishing WebSocket)
		if original != nil {
			original(sessionID, eventType, payload)
		}

		// 2. Forward to browser workspace gateway
		switch eventType {
		case "publishing_progress":
			step, _ := payload["step"].(string)
			status, _ := payload["status"].(string)
			message, _ := payload["message"].(string)

			if status == "started" && step == "publishing_started" {
				eb.gateway.Publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
					"phase":   "publishing",
					"status":  "running",
					"message": message,
				})
			}

			eb.gateway.Publish(workspaceID, ChAIActivity, "publishing_step", map[string]interface{}{
				"step":    step,
				"status":  status,
				"message": message,
			})

		case "publishing_complete":
			eb.gateway.Publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":     "publishing",
				"status":    "success",
				"pr_url":    payload["pr_url"],
				"pr_number": payload["pr_number"],
				"branch":    payload["branch"],
			})
			eb.gateway.Publish(workspaceID, ChGit, "status_changed", map[string]interface{}{
				"reason":    "published",
				"pr_url":    payload["pr_url"],
				"pr_number": payload["pr_number"],
				"branch":    payload["branch"],
			})
		}
	}
}

// extractPathFromArgs extracts the "path" field from tool call arguments JSON.
func extractPathFromArgs(argsRaw json.RawMessage) string {
	if len(argsRaw) == 0 {
		return ""
	}
	var args struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(argsRaw, &args) != nil {
		return ""
	}
	return args.Path
}
