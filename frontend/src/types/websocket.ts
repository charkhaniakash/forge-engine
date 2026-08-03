import type { Citation } from './qa'

/**
 * Channel kinds the WebSocket layer can subscribe to. Each maps to a backend
 * streaming endpoint under /v1/... and carries a discriminated event payload.
 */
export type SocketChannel = 'qa' | 'planning' | 'execution' | 'validation' | 'repair' | 'publishing'

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
  ts?: number
  id?: string
  phase?: string
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

/**
 * Unified stream envelope: wrapper that includes full event metadata
 * (id, seq, ts, phase) as sent by the backend.
 */
export interface UnifiedStreamEnvelope {
  id: string                    // Event UUID
  ch: SocketChannel             // Channel: execution|validation|repair|publishing
  ev: string                    // Event type
  seq: number                   // Monotonic sequence counter
  ts: number                    // Unix milliseconds
  phase: string                 // Phase: executing|validation|repair|publishing
  payload?: Record<string, unknown>
}

/**
 * Subscription request sent to unified stream WebSocket.
 */
export interface SubscriptionRequest {
  type: 'subscribe'
  channels: SocketChannel[]
}

/**
 * Reconnect request sent to unified stream WebSocket to get gap-fill events.
 */
export interface ReconnectRequest {
  type: 'reconnect'
  session_id: string
  last_seq: Record<SocketChannel, number>
}
