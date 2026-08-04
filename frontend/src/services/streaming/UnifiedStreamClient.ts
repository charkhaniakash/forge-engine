import type { ConnectionState, SocketChannel, UnifiedStreamEnvelope } from '@/types/websocket'

interface UnifiedStreamClientOptions {
  workspaceId: string
  token: string
  onEnvelope: (envelope: UnifiedStreamEnvelope) => void
  onStateChange: (state: ConnectionState) => void
  maxRetries?: number
  heartbeatMs?: number
}

/**
 * Unified WebSocket client for a single workspace. Manages one persistent
 * WebSocket connection with channel subscriptions, exponential-backoff reconnect,
 * and client-side heartbeat.
 *
 * Replaces 4 separate WebSocket connections with 1, reducing connection overhead
 * and enabling true session reconnect with gap-fill.
 */
export class UnifiedStreamClient {
  private ws: WebSocket | null = null
  private readonly opts: Required<UnifiedStreamClientOptions>
  private retries = 0
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private subscribedChannels: Set<SocketChannel> = new Set()
  private lastSeq: Partial<Record<SocketChannel, number>> = {}

  constructor(options: UnifiedStreamClientOptions) {
    this.opts = {
      maxRetries: 6,
      heartbeatMs: 25000,
      ...options,
    }
  }

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  private open(): void {
    this.opts.onStateChange(this.retries === 0 ? 'connecting' : 'reconnecting')
    const workspaceId = this.opts.workspaceId
    const token = encodeURIComponent(this.opts.token)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsHost = window.location.host
    const url = `${wsProtocol}://${wsHost}/v1/workspaces/${workspaceId}/stream?token=${token}`

    try {
      this.ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.retries = 0
      this.opts.onStateChange('open')
      this.startHeartbeat()
      // Re-subscribe to channels on reconnect (auto-resume subscriptions)
      if (this.subscribedChannels.size > 0) {
        this.subscribe(Array.from(this.subscribedChannels))
      }
    }

    this.ws.onmessage = (evt) => {
      if (evt.data === 'pong') return
      try {
        const envelope = JSON.parse(evt.data) as UnifiedStreamEnvelope
        // Track seq per channel for gap-fill reconnect
        if (envelope.seq !== undefined) {
          this.lastSeq[envelope.ch] = envelope.seq
        }
        this.opts.onEnvelope(envelope)
      } catch {
        /* non-JSON frame — ignore */
      }
    }

    this.ws.onerror = () => {
      /* onclose handles reconnect */
    }

    this.ws.onclose = () => {
      this.stopHeartbeat()
      if (this.closedByUser) {
        this.opts.onStateChange('closed')
        return
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.retries >= this.opts.maxRetries) {
      this.opts.onStateChange('closed')
      return
    }
    const delay = Math.min(1000 * 2 ** this.retries, 15000)
    this.retries += 1
    this.opts.onStateChange('reconnecting')
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  private startHeartbeat(): void {
    if (!this.opts.heartbeatMs) return
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('ping')
        } catch {
          /* ignore */
        }
      }
    }, this.opts.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * Subscribe to one or more channels. If already connected, sends subscription
   * request immediately. Stores subscriptions for auto-resume on reconnect.
   */
  subscribe(channels: SocketChannel[]): void {
    for (const ch of channels) {
      this.subscribedChannels.add(ch)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        channels: Array.from(this.subscribedChannels),
      })
    }
  }

  /**
   * Unsubscribe from channels.
   */
  unsubscribe(channels: SocketChannel[]): void {
    for (const ch of channels) {
      this.subscribedChannels.delete(ch)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'subscribe',
        channels: Array.from(this.subscribedChannels),
      })
    }
  }

  /**
   * Request gap-fill reconnect: send last_seq per channel, backend replies with
   * only events after those seq numbers. Dramatically reduces reconnect payload.
   */
  requestReconnect(sessionId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'reconnect',
        session_id: sessionId,
        last_seq: this.lastSeq,
      })
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data))
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
  }

  /**
   * Get the last seq seen for a channel (used for gap-fill reconnect).
   */
  getLastSeq(channel: SocketChannel): number {
    return this.lastSeq[channel] ?? -1
  }

  /**
   * Reset seq tracking (useful when starting a new execution).
   */
  resetSeq(): void {
    this.lastSeq = {}
  }
}
