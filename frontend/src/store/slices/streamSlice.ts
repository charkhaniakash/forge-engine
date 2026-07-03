import { createSlice } from '@reduxjs/toolkit'
import { socketEventReceived } from '@/store/actions/socketActions'
import type {
  Citation,
  ExecutionSocketEvent,
  PlanningSocketEvent,
  QASocketEvent,
} from '@/types'

/**
 * Live buffers fed exclusively by the websocket middleware. Feature components
 * read from here for real-time rendering; the authoritative persisted data
 * still comes from RTK Query, which the components re-fetch on terminal events.
 */

export interface ExecutionLiveEvent {
  seq: number
  kind: string
  label: string
  raw: ExecutionSocketEvent
}

interface ExecutionStream {
  events: ExecutionLiveEvent[]
  complete: boolean
}

interface QAStream {
  requestId?: string
  text: string
  streaming: boolean
  citations: Citation[]
  model?: string
  tokenCount?: number
}

interface PlanningStream {
  events: PlanningSocketEvent[]
  stage?: string
}

interface StreamState {
  execution: Record<string, ExecutionStream>
  qa: Record<string, QAStream>
  planning: Record<string, PlanningStream>
}

const initialState: StreamState = {
  execution: {},
  qa: {},
  planning: {},
}

function labelExecutionEvent(ev: ExecutionSocketEvent): string {
  switch (ev.event) {
    case 'reasoning':
      return `💭 ${(ev.message ?? '').slice(0, 120)}`
    case 'tool_call':
      return `🔧 ${ev.tool}(${JSON.stringify(ev.args ?? {}).slice(0, 80)})`
    case 'tool_result':
      return `   ${ev.success ? '✓' : '✗'} ${ev.tool}`
    case 'plan_deviation':
    case 'deviation':
      return `⚠ deviation: ${(ev.message ?? '').slice(0, 120)}`
    case 'step_complete':
      return `✅ step complete: ${(ev.summary ?? '').slice(0, 100)}`
    case 'exec_complete':
      return '🎉 execution complete'
    case 'requires_human':
      return `✋ requires human: ${(ev.message ?? '').slice(0, 100)}`
    case 'execution_error':
    case 'error':
      return `❌ error: ${(ev.message ?? '').slice(0, 120)}`
    default:
      return ev.message ? String(ev.message).slice(0, 120) : ev.event
  }
}

const TERMINAL_EXEC = new Set([
  'exec_complete',
  'execution_error',
  'error',
])

const streamSlice = createSlice({
  name: 'stream',
  initialState,
  reducers: {
    executionStreamCleared(state, action: { payload: string }) {
      delete state.execution[action.payload]
    },
    qaStreamCleared(state, action: { payload: string }) {
      delete state.qa[action.payload]
    },
  },
  extraReducers: (builder) => {
    builder.addCase(socketEventReceived, (state, action) => {
      const { channel, resourceId, event } = action.payload

      if (channel === 'execution') {
        const ev = event as ExecutionSocketEvent
        const bucket =
          state.execution[resourceId] ??
          (state.execution[resourceId] = { events: [], complete: false })
        bucket.events.push({
          seq: ev.seq ?? bucket.events.length,
          kind: ev.event,
          label: labelExecutionEvent(ev),
          raw: ev,
        })
        if (bucket.events.length > 500) bucket.events.shift()
        if (TERMINAL_EXEC.has(ev.event)) bucket.complete = true
        return
      }

      if (channel === 'qa') {
        const bucket =
          state.qa[resourceId] ??
          (state.qa[resourceId] = {
            text: '',
            streaming: false,
            citations: [],
          })
        const ev = event as QASocketEvent
        if (ev.event === 'token') {
          bucket.requestId = ev.request_id
          bucket.text += ev.text
          bucket.streaming = true
        } else if (ev.event === 'done') {
          bucket.streaming = false
          bucket.citations = ev.citations ?? []
          bucket.model = ev.model
          bucket.tokenCount = ev.token_count
        }
        return
      }

      if (channel === 'planning') {
        const ev = event as PlanningSocketEvent
        const bucket =
          state.planning[resourceId] ??
          (state.planning[resourceId] = { events: [] })
        bucket.events.push(ev)
        if (typeof ev.stage === 'string') bucket.stage = ev.stage
      }
    })
  },
})

export const { executionStreamCleared, qaStreamCleared } = streamSlice.actions
export default streamSlice.reducer
