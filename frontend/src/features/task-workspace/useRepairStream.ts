import { useEffect, useRef } from 'react'
import { useAppDispatch } from '@/app/hooks'
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
 * Returns nothing — read the events from `state.stream.repair[sessionId]`.
 */
export function useRepairStream(sessionId: string | undefined, enabled = true): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!enabled || !sessionId || !token) return
    if (wsRef.current) return

    const url = `${websocketBase()}/repair/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data as string) as RepairSocketEvent
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
