import type { ID, ISODate } from './common'

export interface Repository {
  id: ID
  repo_name: string
  repo_full_name: string
  repo_owner: string
  default_branch: string
  private: boolean
  last_synced_at: ISODate | null
}

export type IndexJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'superseded'

export interface IndexJob {
  id: ID
  status: IndexJobStatus
  progress_stage: string | null
  processed_chunks: number
  total_chunks: number | null
  commit_sha: string
  error: string | null
}

export type IndexState = 'not_indexed' | 'indexing' | 'done' | 'failed'

export interface IndexStatus {
  status: IndexState | string
  job: IndexJob | null
}
