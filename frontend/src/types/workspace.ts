import type { ID, ISODate } from './common'

export type WorkspaceStatus =
  | 'provisioning'
  | 'ready'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'destroying'
  | 'destroyed'

export interface Workspace {
  id: ID
  work_item_id: ID
  repo_id: ID
  commit_sha: string
  status: WorkspaceStatus | string
  container_name?: string
  image: string
  cpu_limit: string
  memory_limit_mb: number
  timeout_seconds: number
  started_at?: ISODate
  ready_at?: ISODate
  destroyed_at?: ISODate
  error?: string
  created_at: ISODate
}

export interface WorkspaceLog {
  id: ID
  seq: number
  event_type: string
  lifecycle_event?: string
  command?: string[]
  working_dir?: string
  exit_code?: number
  timed_out: boolean
  duration_ms?: number
  stdout?: string
  stderr?: string
  message?: string
  started_at?: ISODate
  completed_at?: ISODate
}
