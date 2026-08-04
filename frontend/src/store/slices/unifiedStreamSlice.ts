import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ConnectionState, SocketChannel, UnifiedStreamEnvelope } from '@/types/websocket'

export interface UnifiedStreamEvent {
  id: string
  channel: SocketChannel
  seq: number
  ts: number
  phase: string
  event: string
  payload?: Record<string, unknown>
  receivedAt: number
}

// Helper to build a fully-typed Record<SocketChannel, V> initial value.
// SocketChannel = 'qa' | 'planning' | 'execution' | 'validation' | 'repair' | 'publishing'
function emptySeqRecord(): Record<SocketChannel, number> {
  return { qa: 0, planning: 0, execution: 0, validation: 0, repair: 0, publishing: 0 }
}

function emptyLatestRecord(): Record<SocketChannel, UnifiedStreamEvent | null> {
  return { qa: null, planning: null, execution: null, validation: null, repair: null, publishing: null }
}

interface UnifiedStreamState {
  connectionState: ConnectionState
  eventsByResource: Record<string, UnifiedStreamEvent[]>
  lastSeqPerChannel: Record<SocketChannel, number>
  latestByChannel: Record<SocketChannel, UnifiedStreamEvent | null>
}

const initialState: UnifiedStreamState = {
  connectionState: 'idle',
  eventsByResource: {},
  lastSeqPerChannel: emptySeqRecord(),
  latestByChannel: emptyLatestRecord(),
}

export const unifiedStreamSlice = createSlice({
  name: 'unifiedStream',
  initialState,
  reducers: {
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

      state.lastSeqPerChannel[envelope.ch] = envelope.seq
      state.latestByChannel[envelope.ch] = event

      const resourceId = 'default'
      if (!state.eventsByResource[resourceId]) {
        state.eventsByResource[resourceId] = []
      }
      const isDuplicate = state.eventsByResource[resourceId]?.some((e) => e.id === event.id)
      if (!isDuplicate) {
        state.eventsByResource[resourceId]!.push(event)
      }
    },

    unifiedStreamConnectionStateChanged: (state, action: PayloadAction<ConnectionState>) => {
      state.connectionState = action.payload
    },

    clearResourceEvents: (state, action: PayloadAction<string>) => {
      state.eventsByResource[action.payload] = []
    },

    resetSeqTracking: (state) => {
      state.lastSeqPerChannel = emptySeqRecord()
      state.latestByChannel = emptyLatestRecord()
    },

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
