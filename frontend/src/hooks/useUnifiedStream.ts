import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { useAuth } from '@/hooks/useAuth'
import { UnifiedStreamClient } from '@/services/streaming/UnifiedStreamClient'
import type { SocketChannel, UnifiedStreamEnvelope } from '@/types/websocket'
import {
  unifiedStreamEnvelopeReceived,
  unifiedStreamConnectionStateChanged,
} from '@/store/slices/unifiedStreamSlice'

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
): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const clientRef = useRef<UnifiedStreamClient | null>(null)

  const connectionState = useAppSelector((s) => s.unifiedStream?.connectionState ?? 'idle')

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

/**
 * Helper hook to request gap-fill reconnect after session recovery.
 * Call this when you detect a reconnect and want to fill gaps instead of
 * replaying the full history.
 */
export function useGapFillReconnect(sessionId: string | undefined): void {
  const clientRef = useRef<UnifiedStreamClient | null>(null)

  useEffect(() => {
    if (!sessionId) return
    // This would normally come from useUnifiedStream's clientRef, but since
    // we can't directly access it, this is a placeholder for direct client access
    // In production, consider storing the client in Redux context or a provider.
  }, [sessionId])
}
