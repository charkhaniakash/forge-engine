export interface RepairSession {
  id: string
  task_execution_id: string
  workspace_id: string
  trigger_validation_run_id: string
  max_attempts: number
  attempts_used: number
  max_duration_secs: number
  status: 'running' | 'completed' | 'exhausted' | 'escalated' | 'cancelled'
  final_validation_run_id?: string
  escalation_reason?: string
  started_at: string
  completed_at?: string
  created_at: string
}

export type RepairEventType =
  | 'repair_started'
  | 'attempt_started'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'attempt_reasoning'
  | 'attempt_complete'
  | 'repair_complete'
  | 'repair_escalated'

export interface RepairSocketEvent {
  v?: number
  event: RepairEventType
  session_id?: string
  /** Server timestamp (unix ms) — present on all events for feed ordering. */
  ts?: number
  attempt_number?: number
  // repair_started
  attempt?: number
  max_attempts?: number
  // reasoning
  message?: string
  // tool_call / tool_result
  tool?: string
  tool_call_id?: string
  args?: unknown
  success?: boolean
  // attempt_reasoning
  strategy?: string
  confidence?: number
  summary?: string
  // attempt_complete
  outcome?: string
  modified_files?: string[]
  // repair_complete
  final_result?: string
  // repair_escalated
  reason?: string
}
