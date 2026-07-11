import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { appendPublishingEvent } from '@/store/slices/streamSlice'
import { useAuth } from '@/hooks/useAuth'
import { websocketBase } from '@/constants/config'
import type { PublishingSocketEvent } from '@/types/publishing'

/**
 * Subscribes to a publishing session's WebSocket and funnels events into the
 * stream slice via `appendPublishingEvent` (keyed by sessionId). Same shape as
 * useRepairStream: the backend replays buffered events on connect, so a late
 * connection still gets full history; duplicates are deduped by `ts`.
 *
 * Read the events from `state.stream.publishing[sessionId]`.
 */
export function usePublishingStream(sessionId: string | undefined, enabled = true): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | undefined>(undefined)

  const existingEvents = useAppSelector((s) =>
    sessionId ? s.stream.publishing[sessionId]?.events ?? [] : [],
  )
  const seenTsRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    const s = new Set<number>()
    for (const ev of existingEvents) {
      if (ev.ts) s.add(ev.ts)
    }
    seenTsRef.current = s
    // Only re-seed on session change, not on every event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!enabled || !sessionId || !token) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      return
    }
    if (wsRef.current && sessionIdRef.current === sessionId) return
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    sessionIdRef.current = sessionId
    const url = `${websocketBase()}/publishing/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data as string) as PublishingSocketEvent
        if (ev.ts && seenTsRef.current.has(ev.ts)) return
        if (ev.ts) seenTsRef.current.add(ev.ts)
        dispatch(appendPublishingEvent({ sessionId, event: ev }))
        if (ev.event === 'publishing_complete') ws.close()
      } catch {
        /* ignore non-JSON frames */
      }
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null
    }

    return () => {
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [sessionId, token, enabled, dispatch])
}
