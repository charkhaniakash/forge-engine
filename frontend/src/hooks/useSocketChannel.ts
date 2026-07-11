import { useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { wsConnect, wsDisconnect } from '@/store/actions/socketActions'
import { subKey } from '@/store/slices/websocketSlice'
import { useAuth } from './useAuth'
import type { ConnectionState, SocketChannel } from '@/types'

interface UseSocketChannelArgs {
  channel: SocketChannel
  resourceId: string | undefined | null
  /** Path after the API prefix, e.g. `/repos/x/qa/sessions/y/stream`. */
  path: string
  /** Only connect while true (e.g. execution is live). */
  enabled?: boolean
}

/**
 * Subscribes to a WebSocket channel for the lifetime of the component (or while
 * `enabled`). The middleware owns the socket; this hook only dispatches the
 * connect/disconnect commands and returns the current connection state.
 */
export function useSocketChannel({
  channel,
  resourceId,
  path,
  enabled = true,
}: UseSocketChannelArgs): ConnectionState {
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  const state = useAppSelector((s) =>
    resourceId ? s.websocket.connections[subKey(channel, resourceId)] : undefined,
  )

  useEffect(() => {
    if (!enabled || !resourceId || !token) return
    dispatch(wsConnect({ channel, resourceId, token, path }))
    return () => {
      dispatch(wsDisconnect({ channel, resourceId }))
    }
  }, [dispatch, channel, resourceId, path, token, enabled])

  return state ?? 'idle'
}
