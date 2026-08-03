import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ConnectionState, SocketChannel, UnifiedStreamEnvelope } from '@/types/websocket'

/**
 * Unified stream event stored in Redux with full metadata from backend envelope.
 */
export interface UnifiedStreamEvent {
  id: string                    // Event UUID from backend
  channel: SocketChannel        // execution|validation|repair|publishing
  seq: number                   // Monotonic counter per workspace
  ts: number                    // Unix milliseconds (backend time)
  phase: string                 // Current phase
  event: string                 // Event type (e.g., 'step_completed', 'stage_started')
  payload?: Record<string, unknown>
  // Client-side metadata for deduplication
  receivedAt: number            // Client reception time
}

interface UnifiedStreamState {
  connectionState: ConnectionState
  // Store events per resource (workspaceId or taskId)
  eventsByResource: Record<string, UnifiedStreamEvent[]>
  // Track highest seq per channel (used for dedup and gap-fill)
  lastSeqPerChannel: Record<SocketChannel, number>
  // For rendering: expose the most recent envelope for each channel
  latestByChannel: Record<SocketChannel, UnifiedStreamEvent | null>
}

const initialState: UnifiedStreamState = {
  connectionState: 'idle',
  eventsByResource: {},
  lastSeqPerChannel: {},
  latestByChannel: {
    execution: null,
    validation: null,
    repair: null,
    publishing: null,
  },
}

export const unifiedStreamSlice = createSlice({
  name: 'unifiedStream',
  initialState,
  reducers: {
    /**
     * Receive an envelope from the backend via the unified stream.
     * Store it with full metadata, update lastSeq for gap-fill, and
     * deduplicate using the event's id.
     */
    unifiedStreamEnvelopeReceived: (state, action: PayloadAction<UnifiedStreamEnvelope>) => {
      const envelope = action.payload
      const event: UnifiedStreamEvent = {
        id: envelope.id,
        channel: envelope.ch,
        seq: envelope.seq,
        ts: envelope.ts,
        phase: envelope.phase,
        event: envelope.ev,
        payload: envelope.payload,
        receivedAt: Date.now(),
      }

      // Update lastSeq for this channel (used for gap-fill on reconnect)
      state.lastSeqPerChannel[envelope.ch] = envelope.seq

      // Update latest event for this channel (useful for status displays)
      state.latestByChannel[envelope.ch] = event

      // For now, store events in a default resource bucket. In future,
      // we might key by taskId or workspaceId depending on the envelope.
      const resourceId = 'default'
      if (!state.eventsByResource[resourceId]) {
        state.eventsByResource[resourceId] = []
      }

      // Check for duplicates (same id = same event)
      const isDuplicate = state.eventsByResource[resourceId]?.some((e) => e.id === event.id)
      if (!isDuplicate) {
        state.eventsByResource[resourceId]!.push(event)
      }
    },

    /**
     * Connection state changed (idle, connecting, open, reconnecting, closed).
     */
    unifiedStreamConnectionStateChanged: (state, action: PayloadAction<ConnectionState>) => {
      state.connectionState = action.payload
    },

    /**
     * Clear all events for a resource (e.g., when starting a new execution).
     */
    clearResourceEvents: (state, action: PayloadAction<string>) => {
      const resourceId = action.payload
      state.eventsByResource[resourceId] = []
    },

    /**
     * Reset seq tracking and latest event buffers (call when starting a new phase cycle).
     */
    resetSeqTracking: (state) => {
      state.lastSeqPerChannel = {}
      state.latestByChannel = {
        execution: null,
        validation: null,
        repair: null,
        publishing: null,
      }
    },

    /**
     * Manually set the last seq for a channel (useful for persistent session recovery).
     */
    setLastSeq: (
      state,
      action: PayloadAction<{ channel: SocketChannel; seq: number }>,
    ) => {
      state.lastSeqPerChannel[action.payload.channel] = action.payload.seq
    },
  },
})

export const {
  unifiedStreamEnvelopeReceived,
  unifiedStreamConnectionStateChanged,
  clearResourceEvents,
  resetSeqTracking,
  setLastSeq,
} = unifiedStreamSlice.actions

export default unifiedStreamSlice.reducer
