package browserworkspace

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"go.uber.org/zap"

	"github.com/charkhaniakash/forge-engine/backend/internal/execution"
	"github.com/charkhaniakash/forge-engine/backend/internal/streaming"
	"github.com/charkhaniakash/forge-engine/backend/internal/validation"
)

// EventBridge forwards events from existing orchestrators (execution, validation,
// repair, publishing) into the unified workspace gateway so that browser clients
// see AI activity, timeline events, and diagnostics in real-time.
//
// Design: Each phase's publisher is wrapped. The wrapper:
//   1. Calls the original publisher (preserves existing per-phase WebSocket behavior)
//   2. Resolves the workspaceID from a per-phase registry (populated by OnStart hooks)
//   3. Forwards to the browser workspace gateway
//   4. (Phase 11) Persists to the durable Event Store for replay survivability
//
// Event lifecycle contract for every phase:
//   phase_started → progress events → phase_completed | phase_failed
type EventBridge struct {
	gateway              *Gateway
	eventStore           *streaming.EventStore // Phase 11: durable persistence (nil = disabled)
	fsService            *FilesystemService
	registryMu           sync.RWMutex
	executionWorkspaces  map[string]string // taskExecutionID → workspaceID
	validationWorkspaces map[string]string // validationRunID → workspaceID
	repairWorkspaces     map[string]string // repairSessionID → workspaceID
	publishingWorkspaces map[string]string // publishingSessionID → workspaceID
	logger               *zap.SugaredLogger
}

// NewEventBridge creates an event bridge.
func NewEventBridge(gateway *Gateway, logger *zap.SugaredLogger) *EventBridge {
	return &EventBridge{
		gateway:              gateway,
		executionWorkspaces:  make(map[string]string),
		validationWorkspaces: make(map[string]string),
		repairWorkspaces:     make(map[string]string),
		publishingWorkspaces: make(map[string]string),
		logger:               logger,
	}
}

// SetEventStore wires the Phase 11 durable event store.
// When set, all events are persisted to stream_events before being broadcast.
// When nil (default during migration), only the in-memory gateway path is used.
func (eb *EventBridge) SetEventStore(es *streaming.EventStore) {
	eb.eventStore = es
}

// emit is the unified event emission path for Phase 11.
// It persists to the Event Store (if configured) AND publishes to the gateway.
//
// Event persistence is intentionally decoupled from the caller's request lifetime.
// We use a detached context because events must be persisted even if the HTTP
// request or agent stream that generated them has already closed. Losing an event
// due to a cancelled request context would violate the "persist-before-broadcast"
// guarantee and create gaps in the replay timeline. The EventStore has its own
// timeout/retry logic for DB writes.
func (eb *EventBridge) emit(workspaceID, channel, event string, payload interface{}, phase string) {
	// Phase 11 path: persist to durable store (which triggers broadcast via onPersist hook)
	if eb.eventStore != nil {
		_, err := eb.eventStore.Append(context.Background(), workspaceID, channel, event, payload, phase, nil)
		if err != nil {
			eb.logger.Warnw("event_bridge_persist_failed",
				"workspace_id", workspaceID, "channel", channel, "event", event, "error", err)
			// Fall through to legacy publish as safety net
		} else {
			// Successfully persisted + broadcast via onPersist hook — done.
			return
		}
	}

	// Legacy path: direct gateway publish (in-memory only, no persistence)
	eb.gateway.Publish(workspaceID, channel, event, payload)
}

// emitWithPhase is emit with explicit phase — preferred for lifecycle events.
func (eb *EventBridge) emitWithPhase(workspaceID, channel, event string, payload interface{}, phase string) {
	eb.emit(workspaceID, channel, event, payload, phase)
}

// publish routes through emit with phase inferred from channel.
func (eb *EventBridge) publish(workspaceID, channel, event string, payload interface{}) {
	phase := inferPhase(channel)
	eb.emit(workspaceID, channel, event, payload, phase)
}

// inferPhase maps a channel to its most likely lifecycle phase.
func inferPhase(channel string) string {
	switch channel {
	case ChFilesystem:
		return "workspace"
	case ChTerminal:
		return "workspace"
	case ChDiagnostics:
		return "validation"
	case ChGit:
		return "publishing"
	default:
		return "" // timeline, ai_activity, collaboration — set explicitly when needed
	}
}

// SetFilesystemService wires the filesystem service for AI write dedup.
func (eb *EventBridge) SetFilesystemService(fs *FilesystemService) {
	eb.fsService = fs
}

// ── Execution registry ────────────────────────────────────────────────────────

// RegisterExecution maps a task execution ID to its workspace ID.
func (eb *EventBridge) RegisterExecution(taskExecutionID, workspaceID string) {
	eb.registryMu.Lock()
	eb.executionWorkspaces[taskExecutionID] = workspaceID
	eb.registryMu.Unlock()
}

// UnregisterExecution removes the mapping when execution completes.
func (eb *EventBridge) UnregisterExecution(taskExecutionID string) {
	eb.registryMu.Lock()
	delete(eb.executionWorkspaces, taskExecutionID)
	eb.registryMu.Unlock()
}

// resolveExecution returns the workspace ID for a task execution (thread-safe).
func (eb *EventBridge) resolveExecution(taskExecutionID string) (string, bool) {
	eb.registryMu.RLock()
	wsID, ok := eb.executionWorkspaces[taskExecutionID]
	eb.registryMu.RUnlock()
	return wsID, ok
}

// ── Validation registry ──────────────────────────────────────────────────────

// RegisterValidation maps a validation run ID to its workspace ID.
func (eb *EventBridge) RegisterValidation(validationRunID, workspaceID string) {
	eb.registryMu.Lock()
	eb.validationWorkspaces[validationRunID] = workspaceID
	eb.registryMu.Unlock()
}

// UnregisterValidation removes the mapping when validation completes.
func (eb *EventBridge) UnregisterValidation(validationRunID string) {
	eb.registryMu.Lock()
	delete(eb.validationWorkspaces, validationRunID)
	eb.registryMu.Unlock()
}

// resolveValidation returns the workspace ID for a validation run (thread-safe).
func (eb *EventBridge) resolveValidation(runID string) (string, bool) {
	eb.registryMu.RLock()
	wsID, ok := eb.validationWorkspaces[runID]
	eb.registryMu.RUnlock()
	return wsID, ok
}

// ── Repair registry ───────────────────────────────────────────────────────────

// RegisterRepair maps a repair session ID to its workspace ID.
func (eb *EventBridge) RegisterRepair(sessionID, workspaceID string) {
	eb.registryMu.Lock()
	eb.repairWorkspaces[sessionID] = workspaceID
	eb.registryMu.Unlock()
}

// UnregisterRepair removes the mapping when repair completes.
func (eb *EventBridge) UnregisterRepair(sessionID string) {
	eb.registryMu.Lock()
	delete(eb.repairWorkspaces, sessionID)
	eb.registryMu.Unlock()
}

// resolveRepair returns the workspace ID for a repair session (thread-safe).
func (eb *EventBridge) resolveRepair(sessionID string) (string, bool) {
	eb.registryMu.RLock()
	wsID, ok := eb.repairWorkspaces[sessionID]
	eb.registryMu.RUnlock()
	return wsID, ok
}

// ── Publishing registry ────────────────────────────────────────────────────────

// RegisterPublishing maps a publishing session ID to its workspace ID.
func (eb *EventBridge) RegisterPublishing(sessionID, workspaceID string) {
	eb.registryMu.Lock()
	eb.publishingWorkspaces[sessionID] = workspaceID
	eb.registryMu.Unlock()
}

// UnregisterPublishing removes the mapping when publishing completes.
func (eb *EventBridge) UnregisterPublishing(sessionID string) {
	eb.registryMu.Lock()
	delete(eb.publishingWorkspaces, sessionID)
	eb.registryMu.Unlock()
}

// resolvePublishing returns the workspace ID for a publishing session (thread-safe).
func (eb *EventBridge) resolvePublishing(sessionID string) (string, bool) {
	eb.registryMu.RLock()
	wsID, ok := eb.publishingWorkspaces[sessionID]
	eb.registryMu.RUnlock()
	return wsID, ok
}

// ── Planning marker ───────────────────────────────────────────────────────────

// EmitPlanningMarker emits completed planning phase entries into the workspace
// timeline. Called at execution start (when the workspace exists), it presents
// the already-completed planning phase as the first timeline entry so the user
// sees the full lifecycle: Planning → Executing → Validation → …
//
// The live thinking stream remains on the dedicated task WebSocket unchanged.
func (eb *EventBridge) EmitPlanningMarker(workspaceID string) {
	eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
		"phase":   "planning",
		"status":  "completed",
		"message": "Planning completed — execution starting",
	})
	eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
		"phase":  "planning",
		"status": "success",
	})
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
		workspaceID, ok := eb.resolveExecution(taskExecutionID)
		if !ok || workspaceID == "" {
			return
		}

		// 3. Forward to browser workspace gateway
		switch event.Event {
		// ── Lifecycle ──
		case "exec_start":
			eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":   "executing",
				"message": event.Message,
			})
			eb.publish(workspaceID, ChAIActivity, "phase_started", map[string]interface{}{
				"phase": "executing",
			})
			// Mark the run as live so the browser IDE shows the pause/stop controls.
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": "Execution running",
			})

		case "exec_complete":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "executing",
				"status": "success",
			})
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status": "completed",
			})

		case "exec_cancelled":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "executing",
				"status": "cancelled",
			})
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status": "stopped",
			})

		// Pause/resume are driven by the collaborate endpoints, but the
		// orchestrator emits these when it actually holds/continues between
		// steps — bridge them so the collaboration status stays authoritative.
		case "exec_paused":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "paused",
				"message": event.Message,
			})

		case "exec_resumed":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": event.Message,
			})

		case "execution_error", "error":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":   "executing",
				"status":  "failed",
				"message": event.Message,
			})
			eb.publish(workspaceID, ChAIActivity, "error", map[string]interface{}{
				"message": event.Message,
			})
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "stopped",
				"message": event.Message,
			})

		// ── Step progress ──
		case "step_started":
			eb.publish(workspaceID, ChTimeline, "step_started", map[string]interface{}{
				"phase": "executing",
				"step":  event.StepID,
			})

		case "step_complete":
			eb.publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":   "executing",
				"step":    event.StepID,
				"status":  "success",
				"message": event.Summary,
			})
			// Notify browser that workspace files changed
			eb.publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason":         "step_complete",
				"modified_files": event.ModifiedFiles,
			})

		case "step_skipped":
			eb.publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":  "executing",
				"step":   event.StepID,
				"status": "skipped",
			})

		// ── AI reasoning activity ──
		case "reasoning":
			eb.publish(workspaceID, ChAIActivity, "reasoning", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "tool_call":
			eb.publish(workspaceID, ChAIActivity, "tool_call", map[string]interface{}{
				"tool":         event.ToolName,
				"args":         event.ToolArgs,
				"tool_call_id": event.ToolCallID,
				"step":         event.StepID,
			})

		case "tool_result":
			eb.publish(workspaceID, ChAIActivity, "tool_result", map[string]interface{}{
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
						if eb.fsService != nil {
							eb.fsService.MarkAIWrite(filePath)
						}
						// Include the content the agent wrote so the frontend can
						// auto-open the file and stream the edit live (v0-style),
						// without a follow-up fetch.
						eb.publish(workspaceID, ChFilesystem, "file_modified", map[string]interface{}{
							"path":    filePath,
							"source":  "ai",
							"content": extractContentFromArgs(event.ToolArgs),
						})
						// Advisory hint: a file changed — the dev server is likely recompiling
						eb.notifyPreviewCompiling(workspaceID, filePath)
					}
				case "create_file":
					if filePath != "" {
						if eb.fsService != nil {
							eb.fsService.MarkAIWrite(filePath)
						}
						eb.publish(workspaceID, ChFilesystem, "file_created", map[string]interface{}{
							"path":    filePath,
							"source":  "ai",
							"content": extractContentFromArgs(event.ToolArgs),
						})
						eb.notifyPreviewCompiling(workspaceID, filePath)
					}
				case "delete_file":
					if filePath != "" {
						if eb.fsService != nil {
							eb.fsService.MarkAIWrite(filePath)
						}
						eb.publish(workspaceID, ChFilesystem, "file_deleted", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
						eb.notifyPreviewCompiling(workspaceID, filePath)
					}
				case "rename_file":
					if filePath != "" {
						if eb.fsService != nil {
							eb.fsService.MarkAIWrite(filePath)
						}
						eb.publish(workspaceID, ChFilesystem, "file_renamed", map[string]interface{}{
							"path":   filePath,
							"source": "ai",
						})
					}
				}
			}

		// ── Deviations ──
		case "plan_deviation", "deviation":
			eb.publish(workspaceID, ChAIActivity, "deviation", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "requires_human":
			eb.publish(workspaceID, ChAIActivity, "requires_human", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})
			eb.publish(workspaceID, ChCollaboration, "requires_human", map[string]interface{}{
				"message": event.Message,
			})

		case "already_satisfied":
			eb.publish(workspaceID, ChAIActivity, "already_satisfied", map[string]interface{}{
				"message": event.Message,
				"step":    event.StepID,
			})

		case "validation_queued":
			eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":   "validation",
				"message": "Automatic validation starting",
			})
		}
	}
}

// ── Validation (Phase 8) ────────────────────────────────────────────────────

// WrapValidationPublisher returns a new ValidationEventPublisher that forwards
// validation events to the browser workspace gateway IN ADDITION to calling the
// original. It resolves workspaceID from the validationWorkspaces registry by
// runID (populated by the orchestrator's OnStart hook).
//
// Lifecycle: validation_start → stage_start/complete → validation_complete
func (eb *EventBridge) WrapValidationPublisher(
	original validation.ValidationEventPublisher,
) validation.ValidationEventPublisher {
	return func(runID string, eventType string, payload map[string]interface{}) {
		// 1. Call original (sends to per-run validation WebSocket)
		if original != nil {
			original(runID, eventType, payload)
		}

		// 2. Resolve workspace ID from registry
		workspaceID, ok := eb.resolveValidation(runID)
		if !ok || workspaceID == "" {
			return
		}

		// 3. Forward to browser workspace gateway
		switch eventType {
		case "validation_start":
			eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":  "validation",
				"status": "running",
				"stack":  payload["stack"],
				"profile": payload["profile"],
			})
			eb.publish(workspaceID, ChDiagnostics, "run_started", payload)
			// Keep collaboration status "running" during validation so the
			// pause/stop controls remain active in the browser IDE.
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": "Validating",
			})

		case "stage_start":
			eb.publish(workspaceID, ChDiagnostics, "stage_started", payload)
			eb.publish(workspaceID, ChAIActivity, "validation_stage", map[string]interface{}{
				"stage":  payload["stage"],
				"status": "running",
			})
			// Send command header to terminal
			stage, _ := payload["stage"].(string)
			command, _ := payload["command"].([]string)
			cmdStr := ""
			if len(command) > 0 {
				cmdStr = " — " + strings.Join(command, " ")
			}
			eb.publish(workspaceID, ChTerminal, "output", map[string]interface{}{
				"terminal_id": "agent",
				"data":        "\r\n\x1b[1;33m$ " + stage + cmdStr + "\x1b[0m\r\n",
			})

		case "stage_complete":
			eb.publish(workspaceID, ChDiagnostics, "stage_completed", payload)
			eb.publish(workspaceID, ChAIActivity, "validation_stage", map[string]interface{}{
				"stage":  payload["stage"],
				"status": "completed",
				"passed": payload["passed"],
			})

		case "stage_output":
			eb.publish(workspaceID, ChDiagnostics, "stage_output", payload)
			// Also send to terminal channel so agent commands appear in user's interactive terminal
			// Use a special terminal_id "agent" for system/agent output
			eb.publish(workspaceID, ChTerminal, "output", map[string]interface{}{
				"terminal_id": "agent",
				"data":        payload["chunk"],
			})

		case "stage_diagnostics":
			eb.publish(workspaceID, ChDiagnostics, "items_added", payload)

		case "stage_skipped":
			eb.publish(workspaceID, ChDiagnostics, "stage_skipped", payload)

		case "validation_paused":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "paused",
				"message": "Paused during validation",
			})

		case "validation_resumed":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": "Validating",
			})

		case "validation_cancelled":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "stopped",
				"message": "Cancelled during validation",
			})

		case "validation_complete":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":   "validation",
				"status":  "completed",
				"overall": payload["overall"],
			})
			eb.publish(workspaceID, ChDiagnostics, "run_completed", payload)

		case "error":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":   "validation",
				"status":  "failed",
				"message": payload["message"],
			})
		}
	}
}

// ── Repair (Phase 9) ────────────────────────────────────────────────────────

// WrapRepairPublisher wraps the repair orchestrator's publish function to also
// forward events to the browser workspace gateway. It resolves workspaceID from
// the repairWorkspaces registry by sessionID (populated by the orchestrator's
// OnStart hook).
//
// Lifecycle: repair_started → attempt_started → reasoning/tool events → attempt_complete → repair_complete|repair_escalated
func (eb *EventBridge) WrapRepairPublisher(
	original func(sessionID, eventType string, payload map[string]interface{}),
) func(sessionID, eventType string, payload map[string]interface{}) {
	return func(sessionID, eventType string, payload map[string]interface{}) {
		// 1. Call original (sends to per-session repair WebSocket)
		if original != nil {
			original(sessionID, eventType, payload)
		}

		// 2. Resolve workspace ID from registry
		workspaceID, ok := eb.resolveRepair(sessionID)
		if !ok || workspaceID == "" {
			return
		}

		// 3. Forward to browser workspace gateway
		switch eventType {
		// ── Lifecycle ──
		case "repair_started":
			eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
				"phase":        "repair",
				"status":       "running",
				"max_attempts": payload["max_attempts"],
			})
			eb.publish(workspaceID, ChAIActivity, "repair_started", payload)
			// Keep collaboration controls active during repair.
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": "Repairing",
			})

		case "repair_complete":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":        "repair",
				"status":       "success",
				"final_result": payload["final_result"],
			})
			eb.publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason": "repair_complete",
			})

		case "repair_escalated":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":  "repair",
				"status": "failed",
				"reason": payload["reason"],
			})

		// ── Attempt progress ──
		case "attempt_started":
			eb.publish(workspaceID, ChTimeline, "step_started", map[string]interface{}{
				"phase":          "repair",
				"attempt_number": payload["attempt_number"],
			})
			eb.publish(workspaceID, ChAIActivity, "repair_attempt_started", payload)

		case "attempt_complete":
			eb.publish(workspaceID, ChTimeline, "step_completed", map[string]interface{}{
				"phase":          "repair",
				"status":         "completed",
				"attempt_number": payload["attempt_number"],
				"outcome":        payload["outcome"],
			})
			// Files changed during repair attempt
			eb.publish(workspaceID, ChFilesystem, "files_may_have_changed", map[string]interface{}{
				"reason":         "repair_attempt_complete",
				"modified_files": payload["modified_files"],
			})

		case "attempt_reasoning":
			eb.publish(workspaceID, ChAIActivity, "repair_strategy", map[string]interface{}{
				"strategy":   payload["strategy"],
				"confidence": payload["confidence"],
				"summary":    payload["summary"],
			})

		// ── AI reasoning activity ──
		case "reasoning":
			eb.publish(workspaceID, ChAIActivity, "repair_reasoning", map[string]interface{}{
				"message":        payload["message"],
				"attempt_number": payload["attempt_number"],
			})

		case "tool_call":
			eb.publish(workspaceID, ChAIActivity, "repair_tool_call", map[string]interface{}{
				"tool":           payload["tool"],
				"tool_call_id":   payload["tool_call_id"],
				"attempt_number": payload["attempt_number"],
			})

		case "tool_result":
			eb.publish(workspaceID, ChAIActivity, "repair_tool_result", map[string]interface{}{
				"tool":           payload["tool"],
				"success":        payload["success"],
				"tool_call_id":   payload["tool_call_id"],
				"attempt_number": payload["attempt_number"],
			})
			// Emit precise file change events for repair writes + notify preview
			if success, ok := payload["success"].(bool); ok && success {
				if tool, ok := payload["tool"].(string); ok {
					filePath, _ := payload["path"].(string)
					if filePath == "" {
						if args, ok := payload["args"].(map[string]interface{}); ok {
							filePath, _ = args["path"].(string)
						}
					}
					switch tool {
					case "write_file":
						eb.publish(workspaceID, ChFilesystem, "file_modified", map[string]interface{}{
							"path":   filePath,
							"source": "repair",
						})
						if filePath != "" {
							eb.notifyPreviewCompiling(workspaceID, filePath)
						}
					case "create_file":
						eb.publish(workspaceID, ChFilesystem, "file_created", map[string]interface{}{
							"path":   filePath,
							"source": "repair",
						})
						if filePath != "" {
							eb.notifyPreviewCompiling(workspaceID, filePath)
						}
					case "delete_file":
						eb.publish(workspaceID, ChFilesystem, "file_deleted", map[string]interface{}{
							"path":   filePath,
							"source": "repair",
						})
						if filePath != "" {
							eb.notifyPreviewCompiling(workspaceID, filePath)
						}
					}
				}
			}

		case "repair_paused":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "paused",
				"message": "Paused during repair",
			})

		case "repair_resumed":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "running",
				"message": "Repairing",
			})

		case "repair_cancelled":
			eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
				"status":  "stopped",
				"message": "Cancelled during repair",
			})
		}
	}
}

// ── Publishing (Phase 10) ───────────────────────────────────────────────────

// WrapPublishingPublisher wraps the publishing orchestrator's publish function to
// forward events to the browser workspace gateway. It resolves workspaceID from
// the publishingWorkspaces registry by sessionID (populated by the orchestrator's
// OnStart hook).
//
// Lifecycle: publishing_started → step progress → publishing_complete
func (eb *EventBridge) WrapPublishingPublisher(
	original func(sessionID, eventType string, payload map[string]interface{}),
) func(sessionID, eventType string, payload map[string]interface{}) {
	return func(sessionID, eventType string, payload map[string]interface{}) {
		// 1. Call original (sends to per-session publishing WebSocket)
		if original != nil {
			original(sessionID, eventType, payload)
		}

		// 2. Resolve workspace ID from registry
		workspaceID, ok := eb.resolvePublishing(sessionID)
		if !ok || workspaceID == "" {
			return
		}

		// 3. Forward to browser workspace gateway
		switch eventType {
		case "publishing_progress":
			step, _ := payload["step"].(string)
			status, _ := payload["status"].(string)
			message, _ := payload["message"].(string)

			if status == "started" && step == "publishing_started" {
				eb.publish(workspaceID, ChTimeline, "phase_started", map[string]interface{}{
					"phase":   "publishing",
					"status":  "running",
					"message": message,
				})
				// Keep collaboration controls active during publishing.
				eb.publish(workspaceID, ChCollaboration, "state_changed", map[string]interface{}{
					"status":  "running",
					"message": "Publishing",
				})
			}

			eb.publish(workspaceID, ChAIActivity, "publishing_step", map[string]interface{}{
				"step":    step,
				"status":  status,
				"message": message,
			})

		case "publishing_complete":
			eb.publish(workspaceID, ChTimeline, "phase_completed", map[string]interface{}{
				"phase":     "publishing",
				"status":    "success",
				"pr_url":    payload["pr_url"],
				"pr_number": payload["pr_number"],
				"branch":    payload["branch"],
			})
			eb.publish(workspaceID, ChGit, "status_changed", map[string]interface{}{
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

// extractContentFromArgs pulls the "content" field from a write/create tool's
// args so the frontend can render the AI's edit live in the code editor.
func extractContentFromArgs(argsRaw json.RawMessage) string {
	if len(argsRaw) == 0 {
		return ""
	}
	var args struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(argsRaw, &args) != nil {
		return ""
	}
	return args.Content
}

// ── Preview channel forwarding ────────────────────────────────────────────────
// File changes from the execution / repair phases can trigger a dev-server
// recompile. The EventBridge intercepts write_file / create_file / delete_file
// tool results and publishes a `preview_compiling` hint on the preview channel
// so the browser iframe shows the "Compiling…" overlay immediately — before the
// dev server actually emits its recompile log line.
//
// notifyPreviewCompiling is intentionally a no-op.
//
// Previously this emitted preview_compiling events on every file write, which
// caused the frontend to show the compiling overlay and the LivePreview component
// to attempt re-starting the dev server for every file change — even when no
// dev server session existed. The spurious preview_compiling events triggered
// repeated StartPreview calls from the frontend, each of which ran DetectDevServer
// (3× test -e commands) and started a new npm process, flooding the logs.
//
// The authoritative preview_compiling signal comes from runDevServer parsing the
// actual dev server stdout. This method is kept as a no-op so callers don't need
// to be updated, but it no longer emits anything.
func (eb *EventBridge) notifyPreviewCompiling(workspaceID, filePath string) {
	// no-op: see comment above
	_ = workspaceID
	_ = filePath
}
