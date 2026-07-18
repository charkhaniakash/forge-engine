import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  AIActivityEvent,
  CollaborationStatus,
  DiagnosticItem,
  TimelineEvent,
} from '@/types/workspaceEditor'

/** Transitional action triggered by a control_requested WS event (multi-tab). */
export type TransitionalAction = 'pausing' | 'stopping' | 'resuming'

interface ActivityState {
  timeline: TimelineEvent[]
  aiEvents: AIActivityEvent[]
  diagnostics: DiagnosticItem[]
  /** Live command output chunks (install/build/test/lint), in arrival order. */
  output: string[]
  collaboration: { status: CollaborationStatus; label?: string }
  /**
   * Set via `control_requested` WS event so all tabs see the transitional state.
   * Cleared when an authoritative collaboration status arrives that confirms it.
   */
  transitionalAction: TransitionalAction | null
}

const initialState: ActivityState = {
  timeline: [],
  aiEvents: [],
  diagnostics: [],
  output: [],
  collaboration: { status: 'idle' },
  transitionalAction: null,
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
      // Clear transitional action when an authoritative status confirms it
      if (state.transitionalAction) {
        const s = action.payload.status
        if (
          (state.transitionalAction === 'pausing' && s === 'paused') ||
          (state.transitionalAction === 'stopping' && (s === 'stopped' || s === 'completed')) ||
          (state.transitionalAction === 'resuming' && s === 'running')
        ) {
          state.transitionalAction = null
        }
      }
    },
    transitionalActionSet(state, action: PayloadAction<TransitionalAction | null>) {
      state.transitionalAction = action.payload
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
  transitionalActionSet,
  resetActivity,
} = slice.actions

export default slice.reducer
