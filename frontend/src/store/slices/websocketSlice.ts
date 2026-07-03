import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ConnectionState, SocketChannel } from '@/types'

/** Subscription key = `${channel}:${resourceId}`. */
export type SubscriptionKey = string

export function subKey(channel: SocketChannel, resourceId: string): SubscriptionKey {
  return `${channel}:${resourceId}`
}

interface WebSocketState {
  connections: Record<SubscriptionKey, ConnectionState>
}

const initialState: WebSocketState = {
  connections: {},
}

const websocketSlice = createSlice({
  name: 'websocket',
  initialState,
  reducers: {
    connectionStateChanged(
      state,
      action: PayloadAction<{ key: SubscriptionKey; state: ConnectionState }>,
    ) {
      state.connections[action.payload.key] = action.payload.state
    },
    connectionClosed(state, action: PayloadAction<SubscriptionKey>) {
      delete state.connections[action.payload]
    },
  },
})

export const { connectionStateChanged, connectionClosed } = websocketSlice.actions
export default websocketSlice.reducer
