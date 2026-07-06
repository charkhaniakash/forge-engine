import type { ID, ISODate } from './common'

export type ValidationRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error'
export type ValidationOverallResult =
  | 'passed'
  | 'failed_repairable'
  | 'failed_requires_human'
  | 'failed_environment'

export type ValidationStageStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'error'

export interface ValidationRun {
  id: ID
  task_execution_id: ID
  workspace_id: ID
  stack: string
  language: string
  framework: string
  package_manager: string
  profile_id: string
  run_type: 'baseline' | 'post_change'
  baseline_enabled: boolean
  baseline_run_id?: ID
  status: ValidationRunStatus | string
  overall_result?: ValidationOverallResult | string
  error?: string
  started_at?: ISODate
  completed_at?: ISODate
  created_at: ISODate
  updated_at: ISODate
}

export interface ValidationStage {
  id: ID
  validation_run_id: ID
  stage: string
  sequence_number: number
  status: ValidationStageStatus | string
  command?: string[]
  exit_code?: number
  stdout?: string
  stderr?: string
  combined_output?: string
  duration_ms?: number
  started_at?: ISODate
  completed_at?: ISODate
  created_at: ISODate
}

export interface ValidationDiagnostic {
  id: ID
  validation_run_id: ID
  stage: string
  severity: 'error' | 'warning' | 'info' | string
  category: string
  file_path?: string
  line_number?: number
  column_number?: number
  symbol_name?: string
  message: string
  raw_output?: string
  tool: string
  origin: string
  confidence: number
  repair_category?: 'auto_fixable' | 'needs_human' | 'unknown' | string
  created_at: ISODate
}

/** Combined GET .../validation response */
export interface ValidationSnapshot {
  run: ValidationRun
  stages: ValidationStage[]
}

/** WebSocket event from validation stream */
export interface ValidationSocketEvent {
  v?: number
  event: string
  run_id?: string
  stack?: string
  profile?: string
  stage?: string
  exit_code?: number
  duration_ms?: number
  passed?: boolean
  reason?: string
  count?: number
  errors?: number
  warnings?: number
  overall?: string
  total_errors?: number
  total_warnings?: number
  chunk?: string
  [key: string]: unknown
}
