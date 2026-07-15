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
  collaboration: { status: CollaborationStatus; label?: string }
}

const initialState: ActivityState = {
  timeline: [],
  aiEvents: [],
  diagnostics: [],
  collaboration: { status: 'idle' },
}

const MAX_AI_EVENTS = 500

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
  collaborationChanged,
  resetActivity,
} = slice.actions

export default slice.reducer
