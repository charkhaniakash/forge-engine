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
import type { PublishingSocketEvent } from '@/types/publishing'

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
  /** Client-perceived arrival time (ms epoch) — sockets carry no timestamp. */
  receivedAt: number
}

export interface ValidationLiveEvent {
  seq: number
  kind: string
  label: string
  raw: ValidationSocketEvent
  receivedAt: number
}

interface ValidationStream {
  events: ValidationLiveEvent[]
  complete: boolean
  /** Highest seq seen — used for dedup on replay + live overlap. */
  lastSeq: number
}

interface ExecutionStream {
  events: ExecutionLiveEvent[]
  complete: boolean
  /** Highest seq seen — used for dedup on replay + live overlap. */
  lastSeq: number
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

interface PublishingStream {
  events: PublishingSocketEvent[]
  complete: boolean
}

interface StreamState {
  execution: Record<string, ExecutionStream>
  qa: Record<string, QAStream>
  planning: Record<string, PlanningStream>
  validation: Record<string, ValidationStream>
  repair: Record<string, RepairStream>
  publishing: Record<string, PublishingStream>
}

const initialState: StreamState = {
  execution: {},
  qa: {},
  planning: {},
  validation: {},
  repair: {},
  publishing: {},
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
    appendExecutionEvent(
      state,
      action: PayloadAction<{ sessionId: string; event: ExecutionSocketEvent }>,
    ) {
      const { sessionId, event } = action.payload
      const bucket =
        state.execution[sessionId] ??
        (state.execution[sessionId] = { events: [], complete: false, lastSeq: 0 })
      // Seq-based dedup: reject events already processed (replay + live overlap)
      const seq = typeof event.seq === 'number' ? event.seq : bucket.events.length
      if (typeof event.seq === 'number' && event.seq <= bucket.lastSeq) {
        return
      }
      bucket.events.push({
        seq,
        kind: event.event,
        label: labelExecutionEvent(event),
        raw: event,
        receivedAt: Date.now(),
      })
      if (seq > bucket.lastSeq) bucket.lastSeq = seq
      if (bucket.events.length > 500) bucket.events.shift()
      if (TERMINAL_EXEC.has(event.event)) bucket.complete = true
    },
    qaStreamCleared(state, action: PayloadAction<string>) {
      delete state.qa[action.payload]
    },
    appendValidationEvent(
      state,
      action: PayloadAction<{ sessionId: string; event: ValidationSocketEvent }>,
    ) {
      const { sessionId, event } = action.payload
      const bucket =
        state.validation[sessionId] ??
        (state.validation[sessionId] = { events: [], complete: false, lastSeq: 0 })
      // Seq-based dedup: reject events already processed (replay + live overlap)
      const seq = typeof event.seq === 'number' ? event.seq : bucket.events.length
      if (typeof event.seq === 'number' && event.seq <= bucket.lastSeq) {
        return
      }
      bucket.events.push({
        seq,
        kind: event.event,
        label: labelValidationEvent(event),
        raw: event,
        receivedAt: Date.now(),
      })
      if (seq > bucket.lastSeq) bucket.lastSeq = seq
      if (bucket.events.length > 500) bucket.events.shift()
      if (TERMINAL_VALIDATION.has(event.event)) bucket.complete = true
    },
    appendRepairEvent(state, action: PayloadAction<{ sessionId: string; event: RepairSocketEvent }>) {
      const { sessionId, event } = action.payload
      const bucket =
        state.repair[sessionId] ??
        (state.repair[sessionId] = { events: [], complete: false })
      // Deduplicate by timestamp — replayed events carry the same ts as originals.
      if (event.ts && bucket.events.some((e) => e.ts === event.ts && e.event === event.event)) {
        return
      }
      bucket.events.push(event.ts ? event : { ...event, ts: Date.now() })
      if (bucket.events.length > 500) bucket.events.shift()
      if (TERMINAL_REPAIR.has(event.event)) bucket.complete = true
    },
    clearRepairEvents(state, action: PayloadAction<string>) {
      delete state.repair[action.payload]
    },
    appendPublishingEvent(
      state,
      action: PayloadAction<{ sessionId: string; event: PublishingSocketEvent }>,
    ) {
      const { sessionId, event } = action.payload
      const bucket =
        state.publishing[sessionId] ??
        (state.publishing[sessionId] = { events: [], complete: false })
      // Dedup replayed events by timestamp (same pattern as repair).
      if (event.ts && bucket.events.some((e) => e.ts === event.ts && e.event === event.event)) {
        return
      }
      bucket.events.push(event)
      if (bucket.events.length > 500) bucket.events.shift()
      if (event.event === 'publishing_complete') bucket.complete = true
    },
    clearPublishingEvents(state, action: PayloadAction<string>) {
      delete state.publishing[action.payload]
    },
    // Clear every task-keyed stream (planning/execution/validation) for a task.
    // Used on re-plan so a fresh cycle doesn't render the previous run's events.
    // Publishing/repair are keyed by session id and clear themselves once the
    // deleted session refetches to null.
    taskStreamsReset(state, action: PayloadAction<string>) {
      const taskId = action.payload
      delete state.planning[taskId]
      delete state.execution[taskId]
      delete state.validation[taskId]
    },
  },
  extraReducers: (builder) => {
    builder.addCase(socketEventReceived, (state, action) => {
      const { channel, resourceId, event } = action.payload

      if (channel === 'execution') {
        const ev = event as ExecutionSocketEvent
        const bucket =
          state.execution[resourceId] ??
          (state.execution[resourceId] = { events: [], complete: false, lastSeq: 0 })
        // Seq-based dedup: reject events we've already processed (replay + live overlap)
        const seq = ev.seq ?? bucket.events.length
        if (typeof ev.seq === 'number' && ev.seq <= bucket.lastSeq) {
          return
        }
        bucket.events.push({
          seq,
          kind: ev.event,
          label: labelExecutionEvent(ev),
          raw: ev,
          receivedAt: Date.now(),
        })
        if (seq > bucket.lastSeq) bucket.lastSeq = seq
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
        bucket.events.push({ ...ev, receivedAt: Date.now() })
        if (typeof ev.stage === 'string') bucket.stage = ev.stage
      }

      if (channel === 'validation') {
        const ev = event as ValidationSocketEvent
        const bucket =
          state.validation[resourceId] ??
          (state.validation[resourceId] = { events: [], complete: false, lastSeq: 0 })
        // Seq-based dedup: reject events we've already processed (replay + live overlap)
        const seq = (typeof ev.seq === 'number' ? ev.seq : undefined) ?? bucket.events.length
        if (typeof ev.seq === 'number' && ev.seq <= bucket.lastSeq) {
          return
        }
        bucket.events.push({
          seq,
          kind: ev.event,
          label: labelValidationEvent(ev),
          raw: ev,
          receivedAt: Date.now(),
        })
        if (seq > bucket.lastSeq) bucket.lastSeq = seq
        if (bucket.events.length > 500) bucket.events.shift()
        if (TERMINAL_VALIDATION.has(ev.event)) bucket.complete = true
      }
    })
  },
})

export const {
  executionStreamCleared,
  appendExecutionEvent,
  appendValidationEvent,
  qaStreamCleared,
  appendRepairEvent,
  clearRepairEvents,
  appendPublishingEvent,
  clearPublishingEvents,
  taskStreamsReset,
} = streamSlice.actions
export default streamSlice.reducer
