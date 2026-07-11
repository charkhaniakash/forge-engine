/** Phase 10 — Publishing (branch → commit → push → PR). */

export type PublishingStatus =
  | 'pending'
  | 'verifying'
  | 'branching'
  | 'committing'
  | 'conflict_check'
  | 'pushing'
  | 'creating_pr'
  | 'syncing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PublishingSession {
  id: string
  work_item_id: string
  task_execution_id: string
  workspace_id: string
  status: PublishingStatus | string
  current_step: string | null
  branch_name: string | null
  pr_number: number | null
  pr_url: string | null
  draft_mode: boolean
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface PublishingSocketEvent {
  v: number
  event: 'publishing_progress' | 'publishing_complete'
  session_id: string
  step?: string
  status?: 'started' | 'completed' | 'failed'
  message?: string
  pr_url?: string
  pr_number?: number
  branch?: string
  ts: number
}
