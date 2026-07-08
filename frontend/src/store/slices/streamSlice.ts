import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { socketEventReceived } from '@/store/actions/socketActions'
import type {
  Citation,
  ExecutionSocketEvent,
  PlanningSocketEvent,
  QASocketEvent,
  ValidationSocketEvent,
} from '@/types'
import type { RepairSocketEvent } from '@/types/repair'

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

export interface ValidationLiveEvent {
  seq: number
  kind: string
  label: string
  raw: ValidationSocketEvent
}

interface ValidationStream {
  events: ValidationLiveEvent[]
  complete: boolean
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

interface RepairStream {
  events: RepairSocketEvent[]
  complete: boolean
}

interface StreamState {
  execution: Record<string, ExecutionStream>
  qa: Record<string, QAStream>
  planning: Record<string, PlanningStream>
  validation: Record<string, ValidationStream>
  repair: Record<string, RepairStream>
}

const initialState: StreamState = {
  execution: {},
  qa: {},
  planning: {},
  validation: {},
  repair: {},
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

const TERMINAL_VALIDATION = new Set([
  'validation_complete',
  'error',
])

function labelValidationEvent(ev: ValidationSocketEvent): string {
  const stageIcon: Record<string, string> = {
    install: '📦', build: '🔨', test: '🧪', lint: '🔍', format: '✨',
  }
  const icon = ev.stage ? (stageIcon[ev.stage] ?? '⚙️') : '🔬'
  switch (ev.event) {
    case 'validation_start':
      return `🔬 Validation started — stack: ${ev.stack ?? '?'}, profile: ${ev.profile ?? '?'}`
    case 'stage_start':
      return `${icon} ${ev.stage} started`
    case 'stage_output':
      return `  ${(String(ev.chunk ?? '')).trim().slice(0, 120)}`
    case 'stage_complete':
      return `  ${ev.passed ? '✅' : '❌'} ${ev.stage} ${ev.passed ? 'passed' : 'failed'} (exit ${ev.exit_code}, ${ev.duration_ms}ms)`
    case 'stage_skipped':
      return `  ⏭ ${ev.stage} skipped — ${ev.reason}`
    case 'stage_diagnostics':
      return `  📋 ${ev.stage}: ${ev.errors ?? 0} error(s), ${ev.warnings ?? 0} warning(s)`
    case 'validation_complete':
      return `🏁 ${ev.overall ?? 'complete'} — ${ev.total_errors ?? 0} error(s)`
    case 'error':
      return `❌ error`
    default:
      return ev.event
  }
}

const TERMINAL_REPAIR = new Set<string>([
  'repair_complete',
  'repair_escalated',
])

const streamSlice = createSlice({
  name: 'stream',
  initialState,
  reducers: {
    executionStreamCleared(state, action: PayloadAction<string>) {
      delete state.execution[action.payload]
    },
    qaStreamCleared(state, action: PayloadAction<string>) {
      delete state.qa[action.payload]
    },
    appendRepairEvent(state, action: PayloadAction<{ sessionId: string; event: RepairSocketEvent }>) {
      const { sessionId, event } = action.payload
      const bucket =
        state.repair[sessionId] ??
        (state.repair[sessionId] = { events: [], complete: false })
      bucket.events.push(event)
      if (bucket.events.length > 500) bucket.events.shift()
      if (TERMINAL_REPAIR.has(event.event)) bucket.complete = true
    },
    clearRepairEvents(state, action: PayloadAction<string>) {
      delete state.repair[action.payload]
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

      if (channel === 'validation') {
        const ev = event as ValidationSocketEvent
        const bucket =
          state.validation[resourceId] ??
          (state.validation[resourceId] = { events: [], complete: false })
        bucket.events.push({
          seq: (typeof ev.seq === 'number' ? ev.seq : undefined) ?? bucket.events.length,
          kind: ev.event,
          label: labelValidationEvent(ev),
          raw: ev,
        })
        if (bucket.events.length > 500) bucket.events.shift()
        if (TERMINAL_VALIDATION.has(ev.event)) bucket.complete = true
      }
    })
  },
})

export const { executionStreamCleared, qaStreamCleared, appendRepairEvent, clearRepairEvents } = streamSlice.actions
export default streamSlice.reducer
