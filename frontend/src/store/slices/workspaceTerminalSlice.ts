import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface TerminalState {
  sessions: Record<string, { id: string; status: string }>
  activeTerminalId: string | null
  /** terminalId → appended output chunks (xterm writes them verbatim). */
  output: Record<string, string[]>
}

const initialState: TerminalState = {
  sessions: {},
  activeTerminalId: null,
  output: {},
}

const MAX_OUTPUT_CHUNKS = 2000

const slice = createSlice({
  name: 'workspaceTerminal',
  initialState,
  reducers: {
    terminalCreated(state, action: PayloadAction<{ id: string; status?: string }>) {
      const { id, status = 'active' } = action.payload
      state.sessions[id] = { id, status }
      if (!state.activeTerminalId) state.activeTerminalId = id
      if (!state.output[id]) state.output[id] = []
    },
    terminalClosed(state, action: PayloadAction<string>) {
      delete state.sessions[action.payload]
      delete state.output[action.payload]
      if (state.activeTerminalId === action.payload) {
        state.activeTerminalId = Object.keys(state.sessions)[0] ?? null
      }
    },
    setActiveTerminal(state, action: PayloadAction<string>) {
      state.activeTerminalId = action.payload
    },
    terminalOutput(state, action: PayloadAction<{ terminalId: string; data: string }>) {
      const { terminalId, data } = action.payload
      const buf = state.output[terminalId] ?? (state.output[terminalId] = [])
      buf.push(data)
      if (buf.length > MAX_OUTPUT_CHUNKS) buf.splice(0, buf.length - MAX_OUTPUT_CHUNKS)
    },
    resetTerminals() {
      return initialState
    },
  },
})

export const {
  terminalCreated,
  terminalClosed,
  setActiveTerminal,
  terminalOutput,
  resetTerminals,
} = slice.actions

export default slice.reducer
