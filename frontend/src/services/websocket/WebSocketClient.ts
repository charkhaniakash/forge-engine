import type { ConnectionState } from '@/types'

interface WebSocketClientOptions {
  url: string
  onMessage: (data: unknown) => void
  onStateChange: (state: ConnectionState) => void
  /** Max reconnect attempts before giving up. */
  maxRetries?: number
  /** Heartbeat interval in ms. 0 disables. */
  heartbeatMs?: number
}

/**
 * A single managed WebSocket connection with exponential-backoff reconnect and
 * a client-side heartbeat. Owned exclusively by the websocket middleware —
 * React components never instantiate this directly.
 */
export class WebSocketClient {
  private ws: WebSocket | null = null
  private readonly opts: Required<WebSocketClientOptions>
  private retries = 0
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: WebSocketClientOptions) {
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
    try {
      this.ws = new WebSocket(this.opts.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.retries = 0
      this.opts.onStateChange('open')
      this.startHeartbeat()
    }

    this.ws.onmessage = (evt) => {
      // Ignore heartbeat pongs; forward everything else as parsed JSON.
      if (evt.data === 'pong') return
      try {
        this.opts.onMessage(JSON.parse(evt.data))
      } catch {
        /* non-JSON frame — ignore */
      }
    }

    this.ws.onerror = () => {
      /* onclose handles the reconnect path */
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

  send(data: unknown): void {
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
}
