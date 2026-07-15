/**
 * WorkspaceSocketManager — one multiplexed WebSocket per workspace.
 *
 * All Phase 10B channels (filesystem, terminal, timeline, ai_activity, …) share
 * a single connection. Handlers subscribe per channel; the manager fans each
 * inbound envelope out to that channel's handlers. On disconnect it reconnects
 * with exponential backoff and replays missed events via {type:'reconnect'}.
 *
 * This is deliberately independent of the middleware-based `useSocketChannel`
 * used elsewhere: the IDE needs one long-lived multiplexed socket, not one
 * connection per resource.
 */
import { websocketBase } from '@/constants/config'
import type { WSChannel, WSClientMessage, WSEnvelope } from '@/types/workspaceEditor'

type EnvelopeHandler = (env: WSEnvelope) => void
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const RECONNECT_MAX_AGE_MS = 5 * 60 * 1000

interface PersistedSession {
  sessionId: string
  lastSeq: Record<string, number>
  timestamp: number
}

export class WorkspaceSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EnvelopeHandler>>()
  private statusListeners = new Set<StatusHandler>()
  private subscribed = new Set<string>()
  private lastSeq = new Map<string, number>()
  private sessionId: string | null = null
  private workspaceId = ''
  private token = ''
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false

  connect(workspaceId: string, token: string): void {
    this.workspaceId = workspaceId
    this.token = token
    this.closedByUser = false
    this.restoreSession()
    this.open()
  }

  private storageKey(): string {
    return `workspace_session_${this.workspaceId}`
  }

  private restoreSession(): void {
    try {
      const raw = localStorage.getItem(this.storageKey())
      if (!raw) return
      const saved = JSON.parse(raw) as PersistedSession
      if (Date.now() - saved.timestamp > RECONNECT_MAX_AGE_MS) return
      this.sessionId = saved.sessionId
      for (const [ch, seq] of Object.entries(saved.lastSeq ?? {})) {
        this.lastSeq.set(ch, seq)
      }
    } catch {
      // Corrupt / unavailable storage — start fresh.
    }
  }

  private persistSession(): void {
    if (!this.sessionId) return
    const data: PersistedSession = {
      sessionId: this.sessionId,
      lastSeq: Object.fromEntries(this.lastSeq),
      timestamp: Date.now(),
    }
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(data))
    } catch {
      // ignore quota / unavailability
    }
  }

  private open(): void {
    this.emitStatus('connecting')
    const url = `${websocketBase()}/workspace/${this.workspaceId}/stream?token=${encodeURIComponent(this.token)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempts = 0
      // If we have a prior session, ask the server to replay what we missed.
      if (this.sessionId) {
        this.rawSend({
          type: 'reconnect',
          session_id: this.sessionId,
          last_seq: Object.fromEntries(this.lastSeq),
        })
      }
      // Re-assert channel subscriptions (defaults are server-side, but explicit
      // is safe and covers channels added after connect).
      if (this.subscribed.size > 0) {
        this.rawSend({ type: 'subscribe', channels: [...this.subscribed] })
      }
      this.emitStatus('connected')
    }

    ws.onmessage = (e) => {
      let env: WSEnvelope
      try {
        env = JSON.parse(e.data as string) as WSEnvelope
      } catch {
        return
      }
      if (typeof env.seq === 'number' && env.ch) {
        this.lastSeq.set(env.ch, env.seq)
      }
      if (env.ch === 'system' && env.ev === 'connected') {
        const p = env.payload as { session_id?: string } | undefined
        if (p?.session_id) {
          this.sessionId = p.session_id
          this.persistSession()
        }
      }
      this.dispatch(env)
      this.persistSession()
    }

    ws.onerror = () => {
      this.emitStatus('error')
    }

    ws.onclose = () => {
      this.ws = null
      if (this.closedByUser) return
      this.emitStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempts, BACKOFF_MS.length - 1)]
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) this.open()
    }, delay)
  }

  private dispatch(env: WSEnvelope): void {
    const handlers = this.listeners.get(env.ch)
    if (!handlers) return
    for (const h of handlers) {
      try {
        h(env)
      } catch {
        // A misbehaving handler must not break the fan-out.
      }
    }
  }

  private rawSend(msg: WSClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /** Subscribe a handler to a channel. Returns an unsubscribe function. */
  subscribe(channel: WSChannel | string, handler: EnvelopeHandler): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(handler)

    if (!this.subscribed.has(channel)) {
      this.subscribed.add(channel)
      this.rawSend({ type: 'subscribe', channels: [channel] })
    }

    return () => {
      const s = this.listeners.get(channel)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) {
        this.listeners.delete(channel)
        this.subscribed.delete(channel)
        this.rawSend({ type: 'unsubscribe', channels: [channel] })
      }
    }
  }

  /** Observe connection-status changes. Returns an unsubscribe function. */
  onStatus(handler: StatusHandler): () => void {
    this.statusListeners.add(handler)
    return () => this.statusListeners.delete(handler)
  }

  private emitStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error'): void {
    for (const h of this.statusListeners) h(status)
  }

  /** Send an application message on a channel (e.g. terminal input). */
  send(channel: WSChannel | string, event: string, payload: unknown): void {
    this.rawSend({ type: 'channel_msg', ch: channel, ev: event, payload })
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  disconnect(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.listeners.clear()
    this.statusListeners.clear()
    this.subscribed.clear()
  }
}

/** One manager instance for the whole app (single active workspace at a time). */
export const workspaceSocket = new WorkspaceSocketManager()
