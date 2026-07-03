import type { ID, ISODate } from './common'

export interface Citation {
  chunk_id: ID
  commit_sha: string
  file_path: string
  start_line: number
  end_line: number
  language?: string
  chunk_type?: string
  symbol_name?: string
}

export type MessageRole = 'user' | 'assistant'

export interface QAMessage {
  id: ID
  role: MessageRole
  content: string
  citations?: Citation[]
  model?: string
  token_count?: number
  created_at: ISODate
  /** Transient client-side flag while tokens are streaming in. */
  streaming?: boolean
}

export interface QASession {
  id: ID
  repo_id: ID
  commit_sha: string
  title?: string
  created_at: ISODate
}

export interface AskRequest {
  question: string
  request_id: string
}
