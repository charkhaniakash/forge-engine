/**
 * Phase 10B — Cloud Development Workspace (Browser IDE) types.
 *
 * Mirrors the backend `browserworkspace` contract:
 *   - WS envelope:     {ch, ev, seq, ts, payload}   (gateway.Envelope)
 *   - Client message:  {type, channels?, ch?, ev?, payload?, session_id?, last_seq?}
 *
 * Kept separate from types/workspace.ts, which holds the Phase 6 provisioning
 * (lifecycle) types for the same underlying workspace.
 */

/** Server → client message. One unified envelope for every channel. */
export interface WSEnvelope {
  ch: string
  ev: string
  seq: number
  ts: number
  payload: unknown
}

/** Client → server message. */
export interface WSClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'channel_msg' | 'reconnect' | 'ping'
  channels?: string[]
  ch?: string
  ev?: string
  payload?: unknown
  session_id?: string
  last_seq?: Record<string, number>
}

/** All multiplexed channels the gateway exposes. */
export type WSChannel =
  | 'system'
  | 'filesystem'
  | 'terminal'
  | 'execution'
  | 'validation'
  | 'repair'
  | 'publishing'
  | 'git'
  | 'diagnostics'
  | 'timeline'
  | 'ai_activity'
  | 'collaboration'

// ── REST payloads ─────────────────────────────────────────────────────────────

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content: string
  size: number
  language?: string
}

export interface TerminalSession {
  id: string
  workspace_id: string
  cols: number
  rows: number
  status: 'active' | 'closed'
  created_at: string
}

export interface GitStatus {
  branch: string
  modified: string[]
  staged: string[]
  untracked: string[]
}

export interface WorkspaceHealth {
  container: { status: string }
  workspace: { status: string; active_terminals: number }
}

// ── Local view models ───────────────────────────────────────────────────────

export interface OpenFile {
  path: string
  content: string
  language: string
  dirty: boolean
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface TimelineEvent {
  id: string
  phase: string
  step: string
  status: string
  ts: number
  detail?: string
}

export interface AIActivityEvent {
  id: string
  type: string
  label: string
  tool?: string
  ts: number
}

export interface DiagnosticItem {
  id: string
  severity: 'error' | 'warning' | 'info' | string
  file: string
  line?: number
  column?: number
  message: string
}

export type CollaborationStatus =
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'idle'
