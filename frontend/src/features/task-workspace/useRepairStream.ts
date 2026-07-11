import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { appendRepairEvent } from '@/store/slices/streamSlice'
import { useAuth } from '@/hooks/useAuth'
import { websocketBase } from '@/constants/config'
import type { RepairSocketEvent } from '@/types/repair'

/**
 * Subscribes to a repair session's WebSocket and funnels events into the
 * stream slice via `appendRepairEvent` (repair is keyed by sessionId, not
 * taskId). Mirrors the connection the Validation page used, but reusable so
 * the unified workspace can consume repair live too.
 *
 * The backend replays all buffered events on WebSocket connect, so even if
 * the frontend connects late (after polling discovers the session), it will
 * receive the full event history. Duplicates are deduped by timestamp.
 *
 * Returns nothing — read the events from `state.stream.repair[sessionId]`.
 */
export function useRepairStream(sessionId: string | undefined, enabled = true): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | undefined>(undefined)

  // Track known event timestamps to deduplicate replayed events.
  const existingEvents = useAppSelector((s) =>
    sessionId ? s.stream.repair[sessionId]?.events ?? [] : [],
  )
  const seenTsRef = useRef<Set<number>>(new Set())

  // Keep seenTs in sync with store on mount / sessionId change.
  useEffect(() => {
    const s = new Set<number>()
    for (const ev of existingEvents) {
      if (ev.ts) s.add(ev.ts)
    }
    seenTsRef.current = s
  }, [sessionId]) // only re-seed on session change, not every event

  useEffect(() => {
    if (!enabled || !sessionId || !token) {
      // Close existing connection if conditions changed
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      return
    }

    // If already connected to this session, skip
    if (wsRef.current && sessionIdRef.current === sessionId) return

    // Close stale connection (different session)
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    sessionIdRef.current = sessionId
    const url = `${websocketBase()}/repair/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data as string) as RepairSocketEvent
        // Deduplicate replayed events by timestamp
        if (ev.ts && seenTsRef.current.has(ev.ts)) return
        if (ev.ts) seenTsRef.current.add(ev.ts)
        dispatch(appendRepairEvent({ sessionId, event: ev }))
        if (ev.event === 'repair_complete' || ev.event === 'repair_escalated') {
          ws.close()
        }
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
