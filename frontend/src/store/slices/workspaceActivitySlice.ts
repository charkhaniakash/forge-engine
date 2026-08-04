import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  AIActivityEvent,
  CollaborationStatus,
  DiagnosticItem,
  TimelineEvent,
} from '@/types/workspaceEditor'

/** Transitional action triggered by a control_requested WS event (multi-tab). */
export type TransitionalAction = 'pausing' | 'stopping' | 'resuming'

/** Preview / dev-server state, driven by the `preview` WS channel. */
export type PreviewStatus =
  | 'idle'
  | 'starting'
  | 'compiling'
  | 'ready'
  | 'error'
  | 'stopped'

export interface PreviewState {
  status: PreviewStatus
  url: string | null   // proxy URL: /v1/workspace/:id/preview/proxy/
  port: number | null
  /** Incremented every time an HMR update or full reload arrives so the
   *  iframe's `key` prop changes and React re-mounts it (forcing a reload). */
  reloadKey: number
  /** Set when status === 'error' */
  errorMessage: string | null
  /** Last status message from the server output (e.g. "compiled in 230ms") */
  lastMessage: string | null
}

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
  /** Embedded live-preview state */
  preview: PreviewState
}

const initialPreview: PreviewState = {
  status: 'idle',
  url: null,
  port: null,
  reloadKey: 0,
  errorMessage: null,
  lastMessage: null,
}

const initialState: ActivityState = {
  timeline: [],
  aiEvents: [],
  diagnostics: [],
  output: [],
  collaboration: { status: 'idle' },
  transitionalAction: null,
  preview: initialPreview,
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

    // ── Preview actions ────────────────────────────────────────────────────
    previewStarting(state, action: PayloadAction<{ url: string; port: number }>) {
      state.preview.status = 'starting'
      state.preview.url = action.payload.url
      state.preview.port = action.payload.port
      state.preview.errorMessage = null
      state.preview.lastMessage = null
    },
    previewCompiling(state, action: PayloadAction<{ message?: string }>) {
      state.preview.status = 'compiling'
      if (action.payload.message) state.preview.lastMessage = action.payload.message
    },
    previewReady(state, action: PayloadAction<{ url: string; port: number; message?: string }>) {
      state.preview.status = 'ready'
      state.preview.url = action.payload.url
      state.preview.port = action.payload.port
      state.preview.errorMessage = null
      if (action.payload.message) state.preview.lastMessage = action.payload.message
    },
    previewHMR(state, action: PayloadAction<{ type: string; message?: string }>) {
      // Increment reloadKey to trigger iframe refresh
      state.preview.reloadKey += 1
      if (action.payload.message) state.preview.lastMessage = action.payload.message
    },
    previewError(state, action: PayloadAction<{ error?: string; message?: string }>) {
      state.preview.status = 'error'
      state.preview.errorMessage = action.payload.error ?? action.payload.message ?? 'Unknown error'
    },
    previewStopped(state) {
      state.preview.status = 'stopped'
    },
    previewReset(state) {
      state.preview = { ...initialPreview }
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
  previewStarting,
  previewCompiling,
  previewReady,
  previewHMR,
  previewError,
  previewStopped,
  previewReset,
  resetActivity,
} = slice.actions

export default slice.reducer
