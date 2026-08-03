# Implementation Plan — Production Real-Time UX

## Overview

Transform from a polling + disconnected WebSocket system to an industrial-grade real-time architecture where users never need to refresh and always know exactly what's happening.

**Estimated Scope**: 8-10 phases, 20+ changed files, ~2000 LOC modifications

**Core Principle**: Event-driven, single source of truth, automatic state synchronization

---

## Phase A: Foundation (CRITICAL — Must Complete First)

### A1: Create Unified Event Model

**File**: `frontend/src/types/event.ts` (NEW)

Define universal event structure with watermarking:

```typescript
export interface BaseExecutionEvent {
  id: string // UUID
  ts: number // Server timestamp (unix ms)
  phase: 'execution' | 'validation' | 'repair' | 'publishing'
  seq: number // Lamport clock per phase
  receivedAt?: number // Client time (optional, for latency measurement)
}

export interface ExecutionPhaseEvent extends BaseExecutionEvent {
  phase: 'execution'
  event: ExecutionSocketEvent['event']
  payload: ExecutionSocketEvent
}

export interface ValidationPhaseEvent extends BaseExecutionEvent {
  phase: 'validation'
  event: ValidationSocketEvent['event']
  payload: ValidationSocketEvent
}

// ... etc for repair, publishing

export type UnifiedExecutionEvent = 
  | ExecutionPhaseEvent 
  | ValidationPhaseEvent 
  | RepairPhaseEvent 
  | PublishingPhaseEvent
```

**Rationale**: 
- Universal watermarking prevents retrograde updates
- `id` dedupes events across all sources
- `ts` orders events globally
- `seq` orders within phase
- `receivedAt` measures network latency (debugging)

---

### A2: Create Unified WebSocket Manager

**File**: `frontend/src/services/websocket/UnifiedExecutionSocket.ts` (NEW)

```typescript
export class UnifiedExecutionSocketManager {
  private ws: WebSocket | null = null
  private taskId: string
  private token: string
  private sessionId: string | null = null
  private phase: 'execution' | 'validation' | 'repair' | 'publishing' = 'execution'
  
  // Watermarking
  private lastSeq = new Map<string, number>()
  private lastTs = 0
  private seenEventIds = new Set<string>()
  
  // Status observable
  private statusSubject = new BehaviorSubject<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('idle')
  status$ = this.statusSubject.asObservable()
  
  // Event stream
  private eventSubject = new Subject<UnifiedExecutionEvent>()
  events$ = this.eventSubject.asObservable()
  
  constructor(taskId: string, token: string) {
    this.taskId = taskId
    this.token = token
  }
  
  connect(phase: 'execution' | 'validation' | 'repair' | 'publishing'): void {
    this.phase = phase
    this.open()
  }
  
  private open(): void {
    this.statusSubject.next('connecting')
    
    // Unified endpoint for all phases
    const url = `${websocketBase()}/execution/${this.taskId}/${this.phase}/stream?token=${token}`
    
    this.ws = new WebSocket(url)
    
    this.ws.onopen = () => {
      // Request replay of missed events if reconnecting
      if (this.sessionId) {
        this.send({ type: 'reconnect', session_id: this.sessionId, last_seq: Object.fromEntries(this.lastSeq) })
      }
      this.statusSubject.next('connected')
    }
    
    this.ws.onmessage = (e) => {
      const raw = JSON.parse(e.data) as UnifiedExecutionEvent
      
      // Watermarking: prevent retrograde updates
      if (raw.ts < this.lastTs && raw.seq <= (this.lastSeq.get(raw.phase) ?? -1)) {
        console.warn('[v0] Retrograde event rejected', raw)
        return
      }
      
      // Dedup by event ID
      if (this.seenEventIds.has(raw.id)) {
        return
      }
      
      this.seenEventIds.add(raw.id)
      this.lastSeq.set(raw.phase, raw.seq)
      this.lastTs = raw.ts
      
      this.eventSubject.next(raw)
      
      // Persist session for replay
      if (raw.phase === 'system' && raw.event === 'connected') {
        this.sessionId = (raw.payload as any).session_id
        this.persistSession()
      }
    }
    
    this.ws.onclose = () => {
      this.ws = null
      this.statusSubject.next('disconnected')
      this.scheduleReconnect()
    }
  }
  
  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
  
  disconnect(): void {
    this.ws?.close()
    this.ws = null
    this.statusSubject.next('disconnected')
  }
}
```

**Rationale**:
- Single WebSocket per task (not per channel)
- Watermarking built-in
- RxJS observables for reactive state
- Automatic session replay on reconnect

---

### A3: Update Redux Architecture

**File**: `frontend/src/store/slices/executionStreamSlice.ts` (NEW)

Replace the scattered `streamSlice` with a unified, watermarked event buffer:

```typescript
interface ExecutionStreamState {
  taskId: string
  events: UnifiedExecutionEvent[]
  
  // Watermark tracking
  lastSeq: Record<string, number>
  lastTs: number
  seenIds: Set<string>
  
  // Phase tracking
  currentPhase: 'execution' | 'validation' | 'repair' | 'publishing' | null
  
  // Terminal detection
  isTerminal: boolean
  
  // Connection state
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
}

const executionStreamSlice = createSlice({
  name: 'executionStream',
  initialState,
  reducers: {
    appendEvent: (state, action: PayloadAction<UnifiedExecutionEvent>) => {
      const event = action.payload
      
      // Prevent retrograde updates
      const phaseSeq = state.lastSeq[event.phase] ?? -1
      if (event.ts < state.lastTs && event.seq <= phaseSeq) return
      
      // Dedup
      if (state.seenIds.has(event.id)) return
      
      state.events.push(event)
      state.seenIds.add(event.id)
      state.lastSeq[event.phase] = event.seq
      state.lastTs = event.ts
      state.currentPhase = event.phase
      
      // Mark terminal states
      if (['exec_complete', 'validation_complete', 'repair_complete', 'publishing_complete'].includes(event.event)) {
        state.isTerminal = true
      }
    },
    setConnectionStatus: (state, action) => {
      state.connectionStatus = action.payload
    },
    reset: (state) => {
      state.events = []
      state.lastSeq = {}
      state.lastTs = 0
      state.seenIds.clear()
      state.currentPhase = null
      state.isTerminal = false
    }
  }
})

export const { appendEvent, setConnectionStatus, reset } = executionStreamSlice.actions
```

**Rationale**:
- Centralized dedup and watermarking
- Automatic terminal state detection
- Connection status alongside events

---

### A4: Replace WebSocket Middleware

**File**: `frontend/src/store/middleware/unifiedExecutionMiddleware.ts` (NEW)

```typescript
export const unifiedExecutionMiddleware: Middleware = (store) => {
  let socket: UnifiedExecutionSocketManager | null = null
  let subscriptions: Subscription | null = null

  return (next) => (action) => {
    if (connectExecution.match(action)) {
      const { taskId, token, phase } = action.payload
      
      if (!socket || socket.taskId !== taskId) {
        socket?.disconnect()
        socket = new UnifiedExecutionSocketManager(taskId, token)
      }
      
      // Subscribe to all events
      subscriptions?.unsubscribe()
      subscriptions = socket.events$.subscribe(event => {
        store.dispatch(appendEvent(event))
        
        // Auto-invalidate RTK cache on terminal events
        if (event.phase === 'execution' && event.event === 'exec_complete') {
          store.dispatch(baseApi.util.invalidateTags(['Execution']))
        }
        // ... etc for other phases
      })
      
      // Subscribe to status
      socket.status$.subscribe(status => {
        store.dispatch(setConnectionStatus(status))
      })
      
      socket.connect(phase)
      return next(action)
    }

    if (disconnectExecution.match(action)) {
      socket?.disconnect()
      subscriptions?.unsubscribe()
      socket = null
      return next(action)
    }

    return next(action)
  }
}
```

**Rationale**:
- Unified socket lifecycle management
- Automatic cache invalidation
- Single middleware instead of per-channel

---

### A5: Stop Polling on Terminal State

**File**: `frontend/src/services/api/executionApi.ts` (MODIFY)

```typescript
export const executionApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getExecution: builder.query<ExecutionSnapshot, GetExecutionArgs>({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/execution/tasks/${taskId}`,
      }),
      queryFn: async (args, api, extraOptions, baseQuery) => {
        // Get current execution from cache
        const state = (api.getState() as RootState).executionStream
        
        // Stop polling if terminal state reached via WebSocket
        if (state.isTerminal) {
          // Return cached result without polling
          const cache = api.getCacheEntry(getExecution.matchFulfilled(args))
          if (cache?.data) return { data: cache.data }
        }
        
        return baseQuery(args)
      },
      // Smart polling: only while execution is live
      pollingInterval: (result, state: RootState) => {
        const execution = result?.execution
        const isLive = ['pending', 'running'].includes(execution?.status ?? '')
        return isLive ? 3000 : 0 // Stop polling on terminal state
      },
    }),
  }),
})
```

**Rationale**:
- Polling stops automatically on terminal events
- Reduces server load and battery drain
- Single source of truth

---

## Phase B: Visibility (User Always Knows Status)

### B1: Connection Status Badge

**File**: `frontend/src/components/ExecutionPage/ConnectionStatus.tsx` (NEW)

```typescript
export function ConnectionStatus() {
  const status = useAppSelector(s => s.executionStream.connectionStatus)
  
  const statusInfo = {
    idle: { icon: '○', label: 'Idle', color: '#718096' },
    connecting: { icon: '⟳', label: 'Connecting...', color: '#f6ad55', pulse: true },
    connected: { icon: '●', label: 'Live', color: '#48bb78' },
    reconnecting: { icon: '⟳', label: 'Reconnecting...', color: '#f6ad55', pulse: true },
    disconnected: { icon: '●', label: 'Disconnected', color: '#f56565' },
  }[status]
  
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-900">
      <span className={statusInfo.pulse ? 'animate-pulse' : ''} style={{ color: statusInfo.color }}>
        {statusInfo.icon}
      </span>
      <span className="text-sm text-slate-300">{statusInfo.label}</span>
    </div>
  )
}
```

**Usage**: Show in MissionHero banner or status bar

---

### B2: Current Step Highlighting

**File**: `frontend/src/features/task-workspace/TimelineEntry.tsx` (MODIFY)

```typescript
interface TimelineEntryProps {
  entry: ConversationEntry
  isActive: boolean
  isCompleted: boolean
}

export function TimelineEntry({ entry, isActive, isCompleted }: TimelineEntryProps) {
  return (
    <div className={clsx(
      'relative transition-all duration-300',
      isActive && 'ring-2 ring-blue-500 ring-offset-1 rounded-lg',
      isCompleted && 'opacity-75'
    )}>
      {/* Timeline content */}
    </div>
  )
}

// In MissionThread
const currentStep = execution?.current_step_stable_id
entries.map(entry => {
  const isActive = entry.step?.stable_id === currentStep
  const isCompleted = entry.completedAt != null
  return <TimelineEntry entry={entry} isActive={isActive} isCompleted={isCompleted} />
})
```

**Rationale**: User immediately sees which step is running

---

### B3: Phase Transition Indicator

**File**: `frontend/src/components/ExecutionPage/PhaseTransition.tsx` (NEW)

```typescript
export function PhaseTransition() {
  const currentPhase = useAppSelector(s => s.executionStream.currentPhase)
  const previousPhaseRef = useRef(currentPhase)
  const [showBanner, setShowBanner] = useState(false)

  useEffect(() => {
    if (currentPhase && currentPhase !== previousPhaseRef.current) {
      setShowBanner(true)
      previousPhaseRef.current = currentPhase
      const timer = setTimeout(() => setShowBanner(false), 3000)
      return () => clearTimeout(timer)
    }
  }, [currentPhase])

  if (!showBanner) return null

  const phaseLabels = {
    execution: '🚀 Running execution',
    validation: '🧪 Starting validation',
    repair: '🔧 Repairing issues',
    publishing: '📤 Publishing changes',
  }

  return (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 animate-slide-down">
      <div className="px-4 py-2 bg-blue-500 text-white rounded-lg shadow-lg">
        {phaseLabels[currentPhase] || currentPhase}
      </div>
    </div>
  )
}
```

---

## Phase C: Responsiveness (System Feels Alive)

### C1: Optimistic Updates

**File**: `frontend/src/features/task-workspace/ActionButtons.tsx` (MODIFY)

```typescript
const [approveTask, { isLoading: isApproving }] = useApproveTaskMutation()

const handleApprove = async () => {
  // Optimistic update
  dispatch(
    executionStreamSlice.actions.optimisticUpdate({
      taskId,
      status: 'approved',
    })
  )

  try {
    await approveTask({ taskId }).unwrap()
  } catch (error) {
    // Rollback on error
    dispatch(executionStreamSlice.actions.rollback())
    toast.error('Failed to approve')
  }
}
```

---

### C2: Progress Indicators in Validation Stages

**File**: `frontend/src/features/task-workspace/ValidationStages.tsx` (MODIFY)

```typescript
// Backend needs to send this event type:
interface StageProgressEvent extends BaseExecutionEvent {
  phase: 'validation'
  event: 'stage_progress'
  payload: {
    stage: string
    totalLines: number
    processedLines: number
  }
}

// Component
export function ValidationStages({ stages }: ValidationStagesProps) {
  const events = useAppSelector(s => s.executionStream.events)
  
  // Calculate progress per stage
  const progressMap = new Map<string, number>()
  for (const ev of events) {
    if (ev.phase === 'validation' && ev.event === 'stage_progress') {
      const { stage, processedLines, totalLines } = ev.payload
      const pct = totalLines ? Math.round((processedLines / totalLines) * 100) : 0
      progressMap.set(stage, pct)
    }
  }
  
  return (
    <>
      {stages.map(stage => (
        <div key={stage.id} className="mb-4">
          <div className="flex justify-between mb-1">
            <span>{stage.name}</span>
            <span>{progressMap.get(stage.name) ?? 0}%</span>
          </div>
          <ProgressBar value={progressMap.get(stage.name) ?? 0} max={100} />
        </div>
      ))}
    </>
  )
}
```

---

## Phase D: Robustness (Recovery from Interruptions)

### D1: Session Replay on Reconnect

**Already handled in UnifiedExecutionSocketManager**, but need to ensure backend sends `{type:'reconnect', session_id, last_seq}` and replays events.

---

### D2: Skeleton Loaders During Refetch

**File**: `frontend/src/components/ExecutionPage/ExecutionSkeleton.tsx` (NEW)

```typescript
export function ExecutionSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-20 bg-slate-700 rounded-lg" />
      <div className="h-64 bg-slate-700 rounded-lg" />
      <div className="h-32 bg-slate-700 rounded-lg" />
    </div>
  )
}

// In TaskWorkspace
const { data: execution, isLoading, isFetching } = useGetExecutionQuery(...)

return (
  <>
    {isLoading && <ExecutionSkeleton />}
    {!isLoading && isFetching && <div className="opacity-50">{/* content with fade */}</div>}
    {!isLoading && !isFetching && <MissionThread entries={entries} />}
  </>
)
```

---

## Phase E: Polish (Industrial Feel)

### E1: Event Timestamps on Timeline

**File**: `frontend/src/features/task-workspace/ActivityRow.tsx` (MODIFY)

```typescript
interface ActivityRowProps {
  event: UnifiedExecutionEvent
  isLast: boolean
}

export function ActivityRow({ event, isLast }: ActivityRowProps) {
  const time = new Date(event.ts).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit'
  })
  
  return (
    <div className="flex gap-3 mb-4">
      <div className="min-w-fit text-xs text-slate-400">{time}</div>
      <div className="flex-1">
        {/* event content */}
      </div>
    </div>
  )
}
```

---

### E2: Calculate & Show ETA

**File**: `frontend/src/features/task-workspace/ExecutionTimer.tsx` (NEW)

```typescript
export function ExecutionTimer() {
  const events = useAppSelector(s => s.executionStream.events)
  const execution = useAppSelector(s => s.executionStream.execution)
  
  // Find execution_started event
  const startEvent = events.find(e => e.event === 'execution_started')
  const startTime = startEvent?.ts
  
  const now = Date.now()
  const elapsed = startTime ? now - startTime : 0
  const elapsedSeconds = Math.round(elapsed / 1000)
  
  // Very rough: assume average step takes 5 minutes
  const completedSteps = events.filter(e => e.event === 'step_complete').length
  const totalSteps = execution?.steps?.length ?? 0
  const remainingSteps = totalSteps - completedSteps
  const estimatedRemaining = remainingSteps * 5 * 60 * 1000
  
  return (
    <div className="text-sm text-slate-400">
      Elapsed: {formatDuration(elapsedSeconds)}
      {estimatedRemaining > 0 && ` • ETA: ${formatDuration(estimatedRemaining / 1000)}`}
    </div>
  )
}
```

---

## Phase F: Integration & Testing

### F1: Update TaskWorkspace to Use Unified Architecture

**File**: `frontend/src/pages/TaskWorkspace/TaskWorkspace.tsx` (MODIFY - MAJOR)

Replace all `useSocketChannel` calls with unified socket:

```typescript
export function TaskWorkspace() {
  const { id: taskId = '' } = useParams()
  const dispatch = useAppDispatch()
  const { token } = useAuth()
  
  // Connect to unified socket
  useEffect(() => {
    if (!taskId || !token) return
    dispatch(connectExecution({ taskId, token, phase: 'execution' }))
    return () => {
      dispatch(disconnectExecution())
    }
  }, [taskId, token, dispatch])
  
  // Read all state from unified stream
  const events = useAppSelector(s => s.executionStream.events)
  const connectionStatus = useAppSelector(s => s.executionStream.connectionStatus)
  const currentPhase = useAppSelector(s => s.executionStream.currentPhase)
  
  // Build UI from events (existing logic)
  const { 
    plan, 
    conversation, 
    execution, 
    validation, 
    repair, 
    publishing 
  } = buildArtifactsFromEvents(events)
  
  return (
    <>
      <ConnectionStatus />
      <PhaseTransition />
      <ExecutionTimer />
      <MissionThread entries={buildConversation(/* ... */)} />
    </>
  )
}
```

---

### F2: Update Tests

Create comprehensive test suite for:
- ✅ Event watermarking prevents retrograde
- ✅ Dedup prevents duplicate events
- ✅ Terminal state stops polling
- ✅ Reconnect replays events
- ✅ Cache invalidation on completion
- ✅ Optimistic updates rollback on error

---

## Migration Strategy

### Step 1: Deploy New Architecture (Non-Breaking)
- Add `unifiedExecutionMiddleware` alongside old middleware (don't remove yet)
- Add `executionStreamSlice` alongside old `streamSlice`
- New components (ConnectionStatus, PhaseTransition, ExecutionTimer) are opt-in
- Old system still works

### Step 2: Migrate TaskWorkspace Gradually
- Update TaskWorkspace to use new socket + slice
- Toggle via feature flag if needed
- Run both architectures in parallel for A/B testing

### Step 3: Deprecate Old System
- Remove old middleware after migration complete
- Remove old stream slices
- Remove per-channel WebSocket clients

### Step 4: Monitor & Iterate
- Collect metrics on connection quality
- Monitor for missed events
- Gather user feedback on new UX

---

## Success Criteria

### Functional
- ✅ No manual refresh needed
- ✅ Execution state always accurate
- ✅ Validation/Repair/Publishing flow is seamless
- ✅ WebSocket reconnects transparently
- ✅ Events never arrive out-of-order
- ✅ No duplicate events

### UX
- ✅ Connection status always visible
- ✅ Current step highlighted
- ✅ Phase transitions announced
- ✅ Progress bars show completion %
- ✅ ETA displayed for long runs
- ✅ Optimistic updates feel instant
- ✅ Error states clear and actionable

### Performance
- ✅ Polling stops on terminal state
- ✅ No unnecessary RTK Query calls
- ✅ WebSocket connection stable >99%
- ✅ Latency < 500ms for typical events
- ✅ Memory usage stable (no leak)

### Production Readiness
- ✅ Error handling comprehensive
- ✅ Logging sufficient for debugging
- ✅ No hardcoded timers
- ✅ No forced refreshes
- ✅ Scalable to multiple phases
- ✅ Well-documented

---

## Questions for Approval

Before I proceed with implementation, please clarify:

1. **Backend Event Format**: Will backend send `UnifiedExecutionEvent` with `id`, `ts`, `seq`, `phase`? Or do we need to transform incoming events?

2. **Endpoint Changes**: Should backend have `/execution/{taskId}/stream` as single endpoint handling all phases? Or separate endpoints per phase that client switches between?

3. **Session Replay**: Should backend buffer events per session for replay, or only on-demand? What's the max buffer size?

4. **Progress Events**: Should validation stages emit `stage_progress` with line counts? Or keep current discrete events?

5. **Timestamps**: Are backend timestamps in unix milliseconds? UTC or client timezone?

6. **Phase Transitions**: Should backend emit explicit `phase_transition` events, or should client infer from event types?

7. **Optimistic Updates**: Which mutations should have optimistic UI? (approve, reject, start repair, publish, etc.)

8. **Polling Fallback**: If WebSocket fails persistently, should we fall back to polling? Or go full real-time only?

---

**Ready for your approval to begin implementation.**
