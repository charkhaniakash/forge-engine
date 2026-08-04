import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { SocketChannel } from '@/types/websocket'

interface ReconnectSession {
  sessionId: string
  workspaceId: string
  lastSeq: Partial<Record<SocketChannel, number>>
  connectedAt: number
}

interface ReconnectSessionState {
  sessions: Record<string, ReconnectSession>
}

const initialState: ReconnectSessionState = {
  sessions: {},
}

const reconnectSessionSlice = createSlice({
  name: 'reconnectSession',
  initialState,
  reducers: {
    updateSessionSeq(
      state,
      action: PayloadAction<{
        workspaceId: string
        sessionId: string
        lastSeq: Partial<Record<SocketChannel, number>>
      }>,
    ) {
      const { workspaceId, sessionId, lastSeq } = action.payload
      state.sessions[workspaceId] = {
        sessionId,
        workspaceId,
        lastSeq,
        connectedAt: Date.now(),
      }
    },

    clearSession(state, action: PayloadAction<string>) {
      delete state.sessions[action.payload]
    },

    clearAllSessions(state) {
      state.sessions = {}
    },
  },
})

export const {
  updateSessionSeq,
  clearSession,
  clearAllSessions,
} = reconnectSessionSlice.actions

export default reconnectSessionSlice.reducer
