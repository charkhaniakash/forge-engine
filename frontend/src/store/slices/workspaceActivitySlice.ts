import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  AIActivityEvent,
  CollaborationStatus,
  DiagnosticItem,
  TimelineEvent,
} from '@/types/workspaceEditor'

interface ActivityState {
  timeline: TimelineEvent[]
  aiEvents: AIActivityEvent[]
  diagnostics: DiagnosticItem[]
  /** Live command output chunks (install/build/test/lint), in arrival order. */
  output: string[]
  collaboration: { status: CollaborationStatus; label?: string }
}

const initialState: ActivityState = {
  timeline: [],
  aiEvents: [],
  diagnostics: [],
  output: [],
  collaboration: { status: 'idle' },
}

const MAX_AI_EVENTS = 500
const MAX_OUTPUT_CHUNKS = 5000

const slice = createSlice({
  name: 'workspaceActivity',
  initialState,
  reducers: {
    timelineEventUpserted(state, action: PayloadAction<TimelineEvent>) {
      const idx = state.timeline.findIndex((e) => e.id === action.payload.id)
      if (idx === -1) state.timeline.push(action.payload)
      else state.timeline[idx] = { ...state.timeline[idx], ...action.payload }
    },
    aiEventAppended(state, action: PayloadAction<AIActivityEvent>) {
      state.aiEvents.push(action.payload)
      if (state.aiEvents.length > MAX_AI_EVENTS) {
        state.aiEvents.splice(0, state.aiEvents.length - MAX_AI_EVENTS)
      }
    },
    diagnosticsSet(state, action: PayloadAction<DiagnosticItem[]>) {
      state.diagnostics = action.payload
    },
    diagnosticAppended(state, action: PayloadAction<DiagnosticItem>) {
      state.diagnostics.push(action.payload)
    },
    outputAppended(state, action: PayloadAction<string>) {
      state.output.push(action.payload)
      if (state.output.length > MAX_OUTPUT_CHUNKS) {
        state.output.splice(0, state.output.length - MAX_OUTPUT_CHUNKS)
      }
    },
    outputReset(state) {
      state.output = []
    },
    collaborationChanged(
      state,
      action: PayloadAction<{ status: CollaborationStatus; label?: string }>,
    ) {
      state.collaboration = action.payload
    },
    resetActivity() {
      return initialState
    },
  },
})

export const {
  timelineEventUpserted,
  aiEventAppended,
  diagnosticsSet,
  diagnosticAppended,
  outputAppended,
  outputReset,
  collaborationChanged,
  resetActivity,
} = slice.actions

export default slice.reducer
