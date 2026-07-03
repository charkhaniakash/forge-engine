import type { ID, ISODate } from './common'

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'deviated'

export interface TaskExecution {
  id: ID
  work_item_id: ID
  workspace_id: ID
  status: ExecutionStatus | string
  current_step_stable_id?: string
  started_at?: ISODate
  completed_at?: ISODate
  error?: string
}

export interface StepExecution {
  id: ID
  step_stable_id: string
  step_order: number
  status: StepStatus | string
  reasoning?: string
  deviation_note?: string
  started_at?: ISODate
  completed_at?: ISODate
}

export type DiffOperation = 'modify' | 'create' | 'delete' | 'rename'

export interface CodeDiff {
  id: ID
  file_path: string
  operation: DiffOperation | string
  old_path?: string
  diff_unified?: string
  lines_added: number
  lines_removed: number
}

/** Persisted execution event (from GET .../execution/events). */
export interface ExecutionEvent {
  id: ID
  seq: number
  event_type: string
  step_stable_id?: string
  tool_name?: string
  message?: string
  payload?: Record<string, unknown>
  created_at?: ISODate
}

/** Combined GET .../execution response. */
export interface ExecutionSnapshot {
  execution: TaskExecution
  steps: StepExecution[]
}
