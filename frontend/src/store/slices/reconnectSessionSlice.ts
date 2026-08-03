import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { SocketChannel } from '@/types/websocket'

interface ReconnectSession {
  sessionId: string
  workspaceId: string
  lastSeq: Record<SocketChannel, number>
  connectedAt: number
}

interface ReconnectSessionState {
  // Map of workspaceId -> ReconnectSession
  sessions: Record<string, ReconnectSession>
}

const initialState: ReconnectSessionState = {
  sessions: {},
}

const reconnectSessionSlice = createSlice({
  name: 'reconnectSession',
  initialState,
  reducers: {
    /**
     * Save the last seq for each channel when a session is active.
     * Called periodically or on phase transitions to maintain state.
     */
    updateSessionSeq(
      state,
      action: PayloadAction<{
        workspaceId: string
        sessionId: string
        lastSeq: Record<SocketChannel, number>
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

    /**
     * Retrieve saved lastSeq for a workspace (used on reconnect).
     * Returns empty if no session exists.
     */
    getSessionSeq(
      state,
      action: PayloadAction<string>,
    ): Record<SocketChannel, number> {
      const workspaceId = action.payload
      return state.sessions[workspaceId]?.lastSeq || {}
    },

    /**
     * Clear session state (called on explicit disconnect or logout).
     */
    clearSession(
      state,
      action: PayloadAction<string>,
    ) {
      delete state.sessions[action.payload]
    },

    /**
     * Clear all sessions (called on logout).
     */
    clearAllSessions(state) {
      state.sessions = {}
    },
  },
})

export const {
  updateSessionSeq,
  getSessionSeq,
  clearSession,
  clearAllSessions,
} = reconnectSessionSlice.actions
export default reconnectSessionSlice.reducer
