import type { Middleware } from '@reduxjs/toolkit'
import { WebSocketClient } from '@/services/websocket/WebSocketClient'
import { websocketBase } from '@/constants/config'
import {
  socketEventReceived,
  wsConnect,
  wsDisconnect,
} from '@/store/actions/socketActions'
import {
  connectionClosed,
  connectionStateChanged,
  subKey,
} from '@/store/slices/websocketSlice'
import type { ExecutionSocketEvent, ForgeSocketEvent } from '@/types'
import { baseApi } from '@/services/api/baseApi'

/**
 * Map socket event types to RTK Query cache tags that should be invalidated.
 * This ensures UI components re-fetch data when socket events arrive.
 */
function getTagsToInvalidate(event: ForgeSocketEvent, channel: string): Array<
  'Execution' | 'Task' | 'Diff' | 'Validation' | 'Repair' | 'Publishing' | 'Plan' | 'Workspace' | 'WorkspaceLog'
> {
  const tags: Array<'Execution' | 'Task' | 'Diff' | 'Validation' | 'Repair' | 'Publishing' | 'Plan' | 'Workspace' | 'WorkspaceLog'> = []

  if (channel === 'execution' && 'event' in event) {
    const execEvent = event as ExecutionSocketEvent
    const eventType = execEvent.event

    // Map execution events to cache tags
    if (eventType === 'execution_complete' || eventType === 'execution_end') {
      tags.push('Execution', 'Task', 'Diff')
    } else if (eventType === 'execution_start') {
      tags.push('Execution')
    } else if (eventType === 'tool_start' || eventType === 'tool_end') {
      tags.push('Execution')
    }
  } else if (channel === 'validation') {
    tags.push('Validation', 'Execution', 'Task')
  } else if (channel === 'repair') {
    tags.push('Repair', 'Execution', 'Task')
  } else if (channel === 'planning') {
    tags.push('Task', 'Plan')
  }

  return tags as Array<'Execution' | 'Task' | 'Diff' | 'Validation' | 'Repair' | 'Publishing' | 'Plan' | 'Workspace' | 'WorkspaceLog'>
}

/**
 * Owns the lifecycle of every WebSocketClient. Reacts to `wsConnect` /
 * `wsDisconnect` command actions, keeps one client per subscription key, and
 * translates inbound frames into `socketEventReceived` dispatches. This is the
 * *only* place the app touches the WebSocket API.
 *
 * Also invalidates relevant RTK Query cache tags on socket events to trigger
 * automatic data refetches in components.
 */
export const websocketMiddleware: Middleware = (store) => {
  const clients = new Map<string, WebSocketClient>()

  return (next) => (action) => {
    if (wsConnect.match(action)) {
      const { channel, resourceId, token, path } = action.payload
      const key = subKey(channel, resourceId)

      // Already connected/connecting — ignore duplicate subscribe.
      if (clients.has(key)) return next(action)

      const sep = path.includes('?') ? '&' : '?'
      const url = `${websocketBase()}${path}${sep}token=${encodeURIComponent(token)}`

      const client = new WebSocketClient({
        url,
        onMessage: (data) => {
          store.dispatch(
            socketEventReceived({
              channel,
              resourceId,
              event: data as ForgeSocketEvent,
            }),
          )

          // Invalidate relevant cache tags to trigger refetches
          const tagsToInvalidate = getTagsToInvalidate(data as ForgeSocketEvent, channel)
          if (tagsToInvalidate.length > 0) {
            store.dispatch(baseApi.util.invalidateTags(tagsToInvalidate))
          }
        },
        onStateChange: (state) => {
          store.dispatch(connectionStateChanged({ key, state }))
        },
      })

      clients.set(key, client)
      client.connect()
      return next(action)
    }

    if (wsDisconnect.match(action)) {
      const { channel, resourceId } = action.payload
      const key = subKey(channel, resourceId)
      const client = clients.get(key)
      if (client) {
        client.close()
        clients.delete(key)
        store.dispatch(connectionClosed(key))
      }
      return next(action)
    }

    return next(action)
  }
}
