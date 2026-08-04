import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { useAuth } from '@/hooks/useAuth'
import { UnifiedStreamClient } from '@/services/streaming/UnifiedStreamClient'
import type { SocketChannel } from '@/types/websocket'
import {
  unifiedStreamEnvelopeReceived,
  unifiedStreamConnectionStateChanged,
} from '@/store/slices/unifiedStreamSlice'
import { updateSessionSeq } from '@/store/slices/reconnectSessionSlice'

/**
 * Single-use hook to initialize and manage the unified WebSocket connection
 * for a workspace. Call this once per workspace to enable streaming for all
 * phases (execution, validation, repair, publishing) over one persistent
 * connection.
 *
 * Usage:
 *   useUnifiedStream(workspaceId, ['execution', 'validation'])
 *
 * The hook handles:
 * - Connection lifecycle
 * - Reconnect with exponential backoff
 * - Auto-resume subscriptions
 * - Envelope dispatch to Redux
 * - Gap-fill session recovery (with session ID)
 */
export function useUnifiedStream(
  workspaceId: string | undefined,
  channels: SocketChannel[] = ['execution', 'validation', 'repair', 'publishing'],
  enabled = true,
  sessionId?: string,
): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const clientRef = useRef<UnifiedStreamClient | null>(null)

  const connectionState = useAppSelector((s) => s.unifiedStream?.connectionState ?? 'idle')

  // Track connection changes to trigger gap-fill reconnect on recovery
  useEffect(() => {
    if (connectionState === 'open' && clientRef.current && sessionId) {
      // On reconnect, request gap-fill instead of full replay
      clientRef.current.requestReconnect(sessionId)
    }
  }, [connectionState, sessionId])

  // Periodically save lastSeq to Redux for persistence across page reloads
  useEffect(() => {
    if (!clientRef.current || !workspaceId) return

    const interval = setInterval(() => {
      const lastSeq = clientRef.current
        ? Object.fromEntries(
            channels.map((ch) => [ch, clientRef.current!.getLastSeq(ch)]),
          )
        : {}
      dispatch(updateSessionSeq({ workspaceId, sessionId: sessionId || '', lastSeq }))
    }, 5000) // Save every 5s

    return () => clearInterval(interval)
  }, [workspaceId, sessionId, dispatch, channels])

  useEffect(() => {
    if (!enabled || !workspaceId || !token) {
      if (clientRef.current) {
        clientRef.current.close()
        clientRef.current = null
      }
      return
    }

    // If already connected to this workspace, just ensure subscriptions are correct
    if (clientRef.current) {
      clientRef.current.subscribe(channels)
      return
    }

    // Create new unified stream client
    const client = new UnifiedStreamClient({
      workspaceId,
      token,
      onEnvelope: (envelope) => {
        dispatch(unifiedStreamEnvelopeReceived(envelope))
      },
      onStateChange: (state) => {
        dispatch(unifiedStreamConnectionStateChanged(state))
      },
    })

    clientRef.current = client
    client.subscribe(channels)
    client.connect()

    return () => {
      // Note: we do NOT close the client here because it's needed for other parts
      // of the app. Instead, components using the stream should manage their own
      // subscriptions via subscribe/unsubscribe. The unified stream persists for
      // the lifetime of the workspace session.
    }
  }, [workspaceId, token, enabled, dispatch, channels])
}
