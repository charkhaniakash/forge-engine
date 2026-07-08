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
  | 'tool_call'
  | 'attempt_complete'
  | 'repair_complete'
  | 'repair_escalated'

export interface RepairSocketEvent {
  v: number
  event: RepairEventType
  session_id: string
  // repair_started
  attempt?: number
  max_attempts?: number
  // attempt_started
  attempt_number?: number
  // tool_call
  tool?: string
  tool_call_id?: string
  // attempt_complete
  outcome?: string
  modified_files?: string[]
  // repair_complete
  final_result?: string
  // repair_escalated
  reason?: string
}
