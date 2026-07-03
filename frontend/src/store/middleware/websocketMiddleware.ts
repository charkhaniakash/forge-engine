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
import type { ForgeSocketEvent } from '@/types'

/**
 * Owns the lifecycle of every WebSocketClient. Reacts to `wsConnect` /
 * `wsDisconnect` command actions, keeps one client per subscription key, and
 * translates inbound frames into `socketEventReceived` dispatches. This is the
 * *only* place the app touches the WebSocket API.
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
