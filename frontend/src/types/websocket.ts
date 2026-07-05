import type { Citation } from './qa'

/**
 * Channel kinds the WebSocket layer can subscribe to. Each maps to a backend
 * streaming endpoint under /v1/... and carries a discriminated event payload.
 */
export type SocketChannel = 'qa' | 'planning' | 'execution' | 'validation'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

/** Q&A token stream (POST .../ask + WS .../stream). */
export type QASocketEvent =
  | { event: 'token'; request_id: string; text: string }
  | {
      event: 'done'
      request_id: string
      citations?: Citation[]
      model?: string
      token_count?: number
    }

/** Planning progress stream (WS .../tasks/:id/stream). */
export interface PlanningSocketEvent {
  event: string
  message?: string
  stage?: string
  [key: string]: unknown
}

/** Execution live stream (WS .../execution/stream). */
export interface ExecutionSocketEvent {
  event: string
  step_stable_id?: string
  tool?: string
  args?: Record<string, unknown>
  success?: boolean
  message?: string
  summary?: string
  seq?: number
  [key: string]: unknown
}

export type ForgeSocketEvent =
  | QASocketEvent
  | PlanningSocketEvent
  | ExecutionSocketEvent

/** Envelope the WebSocket middleware dispatches into Redux. */
export interface SocketMessage {
  channel: SocketChannel
  /** Resource id (session id, task id) the event belongs to. */
  resourceId: string
  event: ForgeSocketEvent
}
