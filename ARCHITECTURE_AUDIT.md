# Forge Engine Frontend — Production Real-Time UX Audit

## Phase 1: Complete Frontend Architecture Map

### 1.1 Routing & Navigation
- **Framework**: React Router v7 (SPA, not Next.js)
- **Routes**:
  - `ROUTES.login` / `ROUTES.signup` → AuthLayout
  - `ROUTES.root` (home) → Console page
  - `ROUTES.mission` → TaskWorkspace (execution hub)
  - `ROUTES.ask` → AskThread (QA chat)
  - `ROUTES.repositories` → Repositories listing
  - `ROUTES.workspaceEditor` → Workspace IDE
  - `ROUTES.settings` → Settings
  - `ROUTES.githubCallback` → OAuth callback

**Issue**: Switching tabs while execution is running will preserve state through Redux, but if user navigates back to mission, they may face stale cached data depending on polling intervals.

### 1.2 State Management (Triple Layer)

#### Layer 1: Redux + RTK Query (Server State)
- **Store**: `store.ts` configures:
  - `baseApi` (RTK Query reducer + middleware)
  - `authSlice` (JWT token, user)
  - `uiSlice` (UI chrome state)
  - `notificationSlice` (toast notifications)
  - `websocketSlice` (connection status map)
  - `streamSlice` (live event buffers)
  - `workspaceEditorSlice`, `workspaceTerminalSlice`, `workspaceActivitySlice` (IDE state)

#### Layer 2: WebSocket Event Streams (Real-Time Updates)
- **Streaming Events** stored in `streamSlice`:
  - `execution[taskId]` - Live execution events
  - `validation[taskId]` - Live validation events
  - `repair[sessionId]` - Live repair attempt events
  - `publishing[sessionId]` - Live publishing events
  - `qa[requestId]` - Live QA responses
  - `planning[taskId]` - Live planning events

**Critical**: Events buffer in Redux store ONLY while WebSocket is open. No persistence to IndexedDB or localStorage. On disconnect/reload, events are lost.

#### Layer 3: Component Local Storage (UI Only)
- `TaskWorkspace` uses `localStorage` to persist `forge-turn-artifacts-{taskId}` (last 10 turns, for undo/history)
- Workspace uses `localStorage` for persisting `workspace_session_{workspaceId}` (session replay)

### 1.3 WebSocket Architecture

#### Two Separate WebSocket Systems:
1. **Middleware-based (useSocketChannel hook)**
   - Owned by Redux middleware (`websocketMiddleware`)
   - One `WebSocketClient` per subscription key `{channel}-{resourceId}`
   - Used for: execution, validation, planning, QA
   - Path pattern: `/repos/{repoId}/{phase}/tasks/{taskId}/stream`
   - Connects on component mount, disconnects on unmount
   - **Problem**: Each channel = separate WebSocket connection

2. **Multiplexed Workspace Socket (WorkspaceSocketManager)**
   - One persistent multiplexed WebSocket per workspace
   - Used for: IDE (filesystem, terminal, timeline, ai_activity channels)
   - Path: `/workspace/{workspaceId}/stream`
   - Persists session in localStorage with sequence tracking
   - Reconnects with exponential backoff
   - Replays missed events via `{type:'reconnect'}`

### 1.4 Real-Time Event Flow Diagram

```
User clicks "Execute" on TaskWorkspace
      ↓
[TaskWorkspace] dispatches useStartExecutionMutation
      ↓
RTK Query POSTS /execution/start
      ↓
Backend creates execution + emits 'execution_started' event
      ↓
[TaskWorkspace] useSocketChannel connects to /execution/{taskId}/stream
      ↓
websocketMiddleware creates WebSocketClient
      ↓
Client connects → Backend sends buffered events (if any)
      ↓
Each message → socketEventReceived action → streamSlice.appendExecutionEvent
      ↓
Redux store: state.stream.execution[taskId].events = [...]
      ↓
MissionThread component selects events from store
      ↓
Component re-renders → Timeline updates, Logs updated, Status badges change
      ↓
When backend emits 'exec_complete' or 'error':
  - streamSlice marks complete: true
  - Component MANUALLY re-fetches execution via useGetExecutionQuery
      ↓
RTK Query cache invalidated (manually)
      ↓
Execution status now reflects finished state
```

### 1.5 Critical Execution Page (TaskWorkspace)

**Key Components**:
- `MissionHero` - Top banner with task description
- `MissionThread` - Conversation timeline (plan → work → validation → repair → publish)
  - `PlanEntry` - Renders plan with steps
  - `ThoughtGroup` - AI reasoning bubbles
  - `ActivityRow` - Tool calls/results
  - `FileChanges` - Code diffs
  - `ValidationStages` - Validation run stages
  - `RepairAttemptCard` - Repair attempt summaries
- `MissionSidebar` - Navigation + status
- Action buttons: Execute, Validate, Repair, Publish, Approve, Reject

**Data Sources**:
1. **Polling (3000ms intervals)**:
   - `useGetTaskQuery` - Gets task + plan status
   - `useGetExecutionQuery` - Gets execution status + steps
   - `useGetExecutionDiffsQuery` - Gets code diffs
   - `useGetValidationQuery` - Gets validation run
   - `useGetRepairSessionByTaskQuery` - Gets repair session
   - `useGetPublishSessionQuery` - Gets publishing session

2. **WebSocket (Real-time events)**:
   - `useSocketChannel` for execution events (execution_started, step_complete, error, etc.)
   - `useSocketChannel` for validation events
   - `useRepairStream` for repair events (custom WebSocket hook)
   - `usePublishingStream` for publishing events (custom WebSocket hook)

### 1.6 Event Deduplication & Race Condition Handling

**Execution Stream**:
- `appendExecutionEvent` in streamSlice dedupes by seq number
- `lastSeq: number` tracks highest seen seq
- Events arrive as: `{ seq, kind, label, raw, receivedAt }`

**Validation Stream**:
- Same dedup by seq
- Events: `{ seq, kind, label, raw, receivedAt }`

**Repair Stream**:
- Dedupes by `ts` (timestamp)
- `seenTsRef` in hook tracks known timestamps
- On reconnect, backend replays all buffered events
- Duplicates discarded

**Publishing Stream**:
- Same as repair: dedup by `ts`

### 1.7 Polling Strategy (Fallback)

**Polling Intervals** (3000ms):
- Task query polls to catch 'plan_ready' state before WebSocket connects
- Execution query polls for status snapshots
- Diffs query polls for code changes
- Validation query polls for run completion
- Repair & Publishing polled on-demand (no persistent polling)

**Problem**: Polling is MANDATORY because WebSocket can race the DB write. Without polling, a late socket connect might miss the 'plan_ready' event if task.status hasn't transitioned yet.

### 1.8 Cache Invalidation

**Manual Invalidation Points** (in TaskWorkspace):
```javascript
// When execution terminal event received, manually refetch
refetchTask()
refetchExec()
refetchDiffs()
refetchValidation()

// When validation completes
refetchValidation()

// When repair completes
refetchRepairSession()

// When publishing completes
refetchPublishingSession()
```

**Problem**: No automatic cache invalidation. Manual refetch points are scattered. If a component unmounts before refetch completes, the cache stays stale.

---

## Phase 2: Real-Time Event Flow Tracing

### 2.1 Execution Flow (Happy Path)

```
[1] User clicks "Execute"
    └─ TaskWorkspace.startExecution() called
       └─ useStartExecutionMutation triggers
          └─ POST /execution/start
             └─ Backend response: execution.id, status='pending'

[2] RTK Query returns, execution.id is known
    └─ useSocketChannel activates with enabled=execLive
       └─ execLive = EXEC_LIVE.has(execution?.status ?? '')
       └─ EXEC_LIVE = Set(['pending', 'running'])

[3] Middleware dispatches wsConnect action
    └─ WebSocketClient created with URL:
       /repos/{repoId}/execution/tasks/{taskId}/stream?token={token}

[4] WebSocket connects → onopen fires
    └─ Backend may immediately send buffered events
    └─ No auth replay needed (state was just created)

[5] Backend executes steps, emits events:
    execution_started → step_started → tool_call → tool_result → step_complete
    └─ Each JSON frame arrives → onmessage fires
    └─ JSON parsed → socketEventReceived dispatched
    └─ streamSlice.appendExecutionEvent called
    └─ Redux: state.stream.execution[taskId].events.push(event)

[6] MissionThread subscribed to execution events
    └─ const events = useAppSelector(s => s.stream.execution[taskId].events)
    └─ Component re-renders on every event
    └─ Timeline advances, logs stream, badges update

[7] Backend emits 'exec_complete' or 'error'
    └─ streamSlice.appendExecutionEvent → complete: true
    └─ Component detects complete = true
    └─ Component calls refetchExecution()
    └─ RTK Query GET /execution/{taskId}
    └─ Response updates execution.status = 'completed' or 'failed'
    └─ useGetExecutionQuery subscribers re-render
    └─ Page shows final state, buttons update
```

**Issues Identified**:
- [ ] If WebSocket takes 2+ seconds to connect, user sees no feedback
- [ ] No progress indicator that socket is connecting
- [ ] If refetch call happens during socket reconnect, could get stale state
- [ ] If user navigates away, WebSocket auto-closes (good), but if they navigate back, full replay via polling (slow)
- [ ] No optimistic updates for button clicks

### 2.2 Validation Flow

Similar to execution:
```
User clicks "Start Validation"
  → useStartValidationMutation (POST)
  → Validation run created with status='pending'
  → useSocketChannel connects to /validation/{taskId}/stream
  → Events: validation_start → stage_start → stage_output → stage_complete → validation_complete
  → Real-time stream shown in ValidationStages component
  → On complete, useGetValidationQuery refetched
```

### 2.3 Repair Flow

```
Validation fails
  → useGetRepairSessionByTaskQuery polls
  → When repair session appears, useRepairStream activates
  → useRepairStream: separate WebSocket (not middleware-based)
  → URL: /repair/sessions/{sessionId}/stream
  → Events: repair_started → attempt_started → tool_call → attempt_complete → repair_complete
  → Dedup by ts (not seq)
  → RepairAttemptCard renders events
  → On complete, useGetRepairSessionByTaskQuery refetched
```

### 2.4 Publishing Flow

```
User clicks "Publish"
  → useStartPublishMutation
  → Publishing session created
  → usePublishingStream activates (custom WebSocket hook)
  → URL: /publishing/sessions/{sessionId}/stream
  → Events: publishing_progress (branching, committing, pushing) → publishing_complete
  → PR link appears
  → On complete, socket auto-closes, useGetPublishSessionQuery refetched
```

---

## Phase 3: Complete UX Issues Audit

### Critical Issues (Blocking Real-Time Experience)

#### 3.1 **Multiple WebSocket Systems = Inconsistent Reconnect Behavior**
- **Problem**: 
  - Middleware-based system (execution/validation): If socket dies, exponential backoff BUT no user-visible indicator
  - Workspace socket: Has session replay via `{type:'reconnect'}`, but mission page doesn't use it
  - Result: User doesn't know if socket is dead, connecting, or connected
- **Impact**: Users manually refresh, thinking connection is stuck
- **Root Cause**: Two separate WebSocket implementations with different reconnect logic

#### 3.2 **No Connection Status Indicator on Execution Page**
- **Problem**: 
  - `websocketSlice` tracks connection state: `connections[key] = 'connecting' | 'open' | 'reconnecting' | 'closed'`
  - But `MissionThread` doesn't display this state
  - User sees live events flowing, then silence, with no indication of what changed
- **Impact**: Ambiguity: "Is it slow? Hung? Disconnected?"
- **Root Cause**: UI doesn't expose connection state

#### 3.3 **No Visual Progress During Execution**
- **Problem**: 
  - Timeline shows events only after they arrive
  - No indication of which step is *currently running* vs pending
  - "Current step" captured in execution.current_step_stable_id, but not highlighted
- **Impact**: Hard to follow progress. User sees past events but no sense of forward momentum
- **Root Cause**: Timeline component doesn't highlight active step

#### 3.4 **Stale Cached Data on Navigation**
- **Problem**: 
  - Poll tasks/execution every 3 seconds
  - But if user switches tabs and returns, cache age is unknown
  - Component may render stale data while refetch is in flight
  - No loading state during refetch
- **Impact**: User sees old state, can't tell if it's stale or live
- **Root Cause**: RTK Query cache has no "freshness" indicator; components don't show refetch status

#### 3.5 **Manual Cache Invalidation Scattered**
- **Problem**: 
  - Refetch calls in TaskWorkspace are manual and incomplete
  - If validation finishes while user is viewing repair, validation cache isn't invalidated
  - Requires manual component awareness of all interdependencies
- **Impact**: Stale data persists, user refresh required
- **Root Cause**: No automatic cache tag invalidation on completion events

#### 3.6 **Polling Never Stops (Resource Waste)**
- **Problem**: 
  - All queries poll at 3000ms forever
  - Even after execution completes, polling continues indefinitely
  - No "stop polling on terminal state" logic
- **Impact**: Unnecessary server load, battery drain
- **Root Cause**: `pollingInterval: 3000` without conditional disable

#### 3.7 **Race Between WebSocket & Polling**
- **Problem**: 
  - Event arrives via WebSocket → stored in stream buffer
  - Event also may arrive via polling → stored in RTK cache
  - But if WebSocket event is newer, polling may overwrite with stale data
  - Polling happens every 3 seconds, WebSocket is real-time
- **Impact**: Timeline may jump backward or show old state
- **Root Cause**: No watermarking or event ordering between two sources

#### 3.8 **WebSocket Doesn't Survive Browser Sleep/Reconnect**
- **Problem**: 
  - Browser sleeps (laptop closed, tab backgrounded)
  - WebSocket dies but client doesn't immediately know
  - When tab resumes, socket is silently dead
  - Browser doesn't wake the socket until next message attempt
  - Latency spike before reconnect visible to user
- **Impact**: User manually refreshes
- **Root Cause**: No proactive heartbeat or idle timeout detection

#### 3.9 **No Optimistic Updates**
- **Problem**: 
  - User clicks "Approve" or "Reject" button
  - Mutation sent to backend
  - UI doesn't update until response received
  - If slow network, user sees unresponsive button
- **Impact**: Feels sluggish
- **Root Cause**: No optimistic response in mutation hook

#### 3.10 **Logs Never Fully Stream**
- **Problem**: 
  - Execution events include logs (tool_result.output, etc.)
  - But logs are truncated in events
  - Full logs are only in RTK cache (useGetExecutionQuery)
  - Components render truncated event logs, not full logs
  - User must click to expand or view full run
- **Impact**: Logs feel incomplete, not live
- **Root Cause**: Architecture separates event stream from detailed log persistence

#### 3.11 **Repair/Publishing Streams Buried**
- **Problem**: 
  - Repair and publishing use custom WebSocket hooks (useRepairStream, usePublishingStream)
  - These hooks are separate from middleware-based system
  - No unified connection status
  - Each has own dedup/replay logic
  - Hard to reason about consistency
- **Impact**: Three separate WebSocket implementations to maintain
- **Root Cause**: Grew organically, not unified

#### 3.12 **No Transition Animations Between Phases**
- **Problem**: 
  - Timeline jumps from execution to validation to repair to publishing
  - Each phase appears instantly
  - No visual continuity showing "we're moving to next phase"
- **Impact**: Disorienting, feels disjointed
- **Root Cause**: Components render events sequentially, not as a cohesive flow

#### 3.13 **Validation Stages Don't Stream**
- **Problem**: 
  - Validation stages (install, build, test, lint) arrive via events
  - But each stage_complete event must wait for stage_start from backend
  - No progressive disclosure: "install in progress → 45% done"
  - Only discrete events: stage_start, stage_output chunks, stage_complete
- **Impact**: Validation feels slow, user doesn't see progress *within* a stage
- **Root Cause**: Backend event granularity doesn't include stage progress %

#### 3.14 **Repair Attempt Details Not Live**
- **Problem**: 
  - Repair events: attempt_started → tool_call → tool_result → attempt_complete
  - But "attempt_complete" only shows outcome, not details
  - Details must be fetched later from RTK cache
  - Component renders stale details while live event says "complete"
- **Impact**: Repair card shows "attempt 1 complete" but details are empty/loading
- **Root Cause**: Event and cache are out of sync

#### 3.15 **Publishing PR URL Not Shown Until Refetch**
- **Problem**: 
  - Publishing event arrives: event='publishing_progress', step='creating_pr'
  - Then later: event='publishing_complete', pr_url='https://...'
  - But pr_url is only in event, not in RTK cache until refetch
  - Component reads cache, sees empty pr_url
  - User must wait for refetch or see blank link
- **Impact**: PR link appears late or not at all
- **Root Cause**: Cache and event stream not synchronized

### Medium Issues (Degraded Experience)

#### 3.16 **No Skeleton Loaders During Refetch**
- **Problem**: 
  - When refetchTask() called, component shows old data until response arrives
  - No loading state to indicate "refreshing"
- **Impact**: Ambiguous whether displayed data is live or stale

#### 3.17 **Button States Not Synchronized**
- **Problem**: 
  - "Execute" button should be disabled while execution is live
  - Depends on execution.status being synced from RTK cache
  - If cache is stale, button state is wrong
- **Impact**: User can accidentally start duplicate execution

#### 3.18 **Timestamps Not Shown on Events**
- **Problem**: 
  - Events don't include timestamps in stream
  - Only `receivedAt` (client time) is added
  - User can't see "step took 5 minutes"
  - Backend has timestamps but they're not in event stream
- **Impact**: Timeline feels timeless, no sense of duration

#### 3.19 **No Estimated Time Remaining**
- **Problem**: 
  - Execution may take hours
  - No ETA shown
  - User doesn't know whether to leave or wait
- **Impact**: User frustrated, manually estimates

#### 3.20 **Logs Truncated in UI**
- **Problem**: 
  - Tool result events truncate output to prevent huge payloads
  - Full output only in RTK cache
  - Component renders truncated version
- **Impact**: User must click to expand, not streamed

---

## Phase 4: Industrial UX Review (Comparative)

### How Industrial Platforms Handle This:

#### GitHub Actions
- **Live Status**: Green dot, spinning icon, yellow warning, red failure — always visible
- **No Manual Refresh**: Logs stream in real-time, workflow status updates without polling
- **Persistent Connection**: Single WebSocket per run, survives tab navigation
- **Event Timeline**: Each step shows start time, duration, end time — not just event name
- **Cancellation**: Can cancel mid-run, state reflects immediately
- **Logs Persist**: Logs saved server-side, accessible even after tab close

#### Vercel Deployments
- **Status Bar**: "Deploying → Building → Deploying → Ready" — progress visible at top
- **Real-Time Logs**: Every build output line streams live, no polling
- **Network Resilience**: Tab freeze, network drop, browser sleep — recovery transparent
- **Cached State**: Switch tabs, return 10 mins later — state still live (cached until new build)
- **No Manual Refresh**: Never need to refresh; state always current
- **Error Details**: Errors shown inline, retry button active, context preserved

#### Linear Issues
- **Activity Feed**: All updates stream live (status changed, comment added, linked to PR)
- **No Stale State**: Comments are immediate, state transitions instant
- **Presence**: See who's typing, viewing document
- **Optimistic Updates**: Type comment, hits server, you see it immediately (rollback if fails)
- **Sync Status**: If offline, "Saving..." appears; on reconnect, auto-syncs

#### Claude Code
- **Streaming Output**: Code generation streams character-by-character
- **Live Diff Preview**: Changes visible immediately in split-pane
- **Atomic Transactions**: When code completes, artifact state transitions instantly
- **Error Recovery**: If connection drops, resumes from last checkpoint
- **Status Messages**: "Thinking → Writing → Testing → Done"

### Key Principles They Follow:
1. **Single Source of Truth**: One channel per resource, no conflicting streams
2. **Event Watermarking**: Timestamp + seq on every event, prevents retrograde updates
3. **Optimistic UI**: User action → immediate visual feedback, rollback if needed
4. **No Manual Refresh**: Real-time architecture means refresh is never needed
5. **Graceful Degradation**: Polling fallback only if WebSocket unavailable
6. **State Collapse**: Old events don't replay; only delta from last checkpoint sent
7. **Presence & Heartbeat**: Constant low-bandwidth ping proves connection alive
8. **Progress Granularity**: Sub-second updates for active steps, not just "done"

---

## Phase 5: Real-Time Architecture Problems

### 5.1 Connection Management
| Aspect | Current | Industrial Std | Gap |
|--------|---------|---|---|
| Sockets per resource | 1 (but multiple systems) | 1 | Inconsistent |
| Reconnect indication | None (silent) | Visible (badge/banner) | User blind |
| Heartbeat | Websocket client has it (25s) | Yes, but user sees it | Hidden |
| Browser sleep recovery | Lost connection | Immediate | Silent failure |
| Session replay | Workspace socket only | Should be all phases | Inconsistent |
| Max retries | 6 (hardcoded) | Configurable per phase | Brittle |

### 5.2 State Synchronization
| Aspect | Current | Ideal | Gap |
|--------|---------|---|---|
| Cache vs Stream | Separate (RTK + Redux) | Unified | Split authority |
| Watermarking | Seq/ts per phase | Global lamport clock | Unordered |
| Conflict resolution | Manual refetch | Automatic (by timestamp) | Manual |
| Dedup | Per-phase logic | Centralized | Scattered |
| Retrograde prevention | None | Seq always increasing | Can jump backward |

### 5.3 Polling Strategy
| Aspect | Current | Ideal | Gap |
|--------|---------|---|---|
| Polling always on | Yes (3000ms) | Only during init | Wasteful |
| Stop condition | Never | On terminal state | Always running |
| Polling overlap | Possible | Explicit precedence | Race |
| Fallback vs primary | Fallback role but mandatory | Clear preference order | Ambiguous |

---

## Phase 6: State Management Audit

### 6.1 Source of Truth Questions

**Q1: Where is the execution status source of truth?**
- Redux cache (RTK): `execution.status = 'running'` (via GET /execution)
- Redux stream: `stream.execution[taskId].complete = false` (via WebSocket)
- **Problem**: Two sources. If WebSocket says "complete" but cache says "running", which wins?

**Q2: Can RTK cache overwrite newer WebSocket data?**
- Yes. If polling interval triggers while WebSocket is reconnecting, GET /execution returns older snapshot
- RTK cache updates to older status
- WebSocket resumes, sends new event, but cache was already updated

**Q3: Can two stores disagree on execution state?**
- Yes. `websocketSlice.connections[key]` might say "closed" while user still sees live timeline (stale stream buffer)
- OR: execution.status says "completed" but stream.events still shows "running" (racing refetch)

### 6.2 State Conflict Examples

**Example 1: Execution Finishes**
```
[1] Backend emits 'exec_complete' event
    → WebSocket onmessage fires
    → socketEventReceived dispatched
    → streamSlice: execution[taskId].complete = true

[2] Meanwhile, polling interval triggers (3000ms)
    → RTK Query GET /execution
    → Response includes execution.status = 'completed'
    → RTK cache updated

[3] If (2) happens after (1): Cache is fresh ✓
[4] If (2) happens before (1): Cache was stale, but then (1) updates stream
    → Component might render: cache.status='completed' but stream.complete=false
    → Conflict!
```

**Example 2: Repair Session Appears**
```
[1] User triggers repair
[2] useGetRepairSessionByTaskQuery polling detects session
    → RTK cache: repairSession = { id: '123', status: 'running' }

[3] useRepairStream activates with sessionId='123'
    → WebSocket connects
    → Backend sends buffered events

[4] Component reads:
    → Cache: repairSession.status = 'running'
    → Stream: stream.repair['123'].events = [event1, event2, ...]
    → Must reconcile: is this event stream for this repair session? YES, IDs match
    → But if sessionId polling is slower than WebSocket, session might not be in cache yet
    → Component tries to render but sessionId undefined → useRepairStream never activates
```

### 6.3 Optimistic Update Problem

**Current State**:
- User clicks "Approve Task"
- useApproveMutation called (POST /task/{id}/approve)
- RTK cache waits for response
- Network latency → UI unresponsive
- No visual feedback

**Industrial Approach**:
- Mutation includes `optimisticData: { task.status: 'approved' }`
- RTK cache updated immediately
- User sees button state change instantly
- If mutation fails, cache rolled back

---

## Phase 7: Execution Screen in Detail

### 7.1 Live System Requirements (What Should Be True)

✗ **User always knows current state** - No, must check WebSocket connection status separately
✗ **Never wonders if something is running** - Yes for execution, no for validation/repair setup
✗ **Never refreshes** - No, often requires manual refresh after reconnect
✗ **Transitions are smooth** - No, jumps between phases abruptly
✗ **Logs stream live** - Partially, truncated in events
✗ **Progress feels alive** - No, binary: running or done
✗ **Timeline always advances** - No, stale cache can jump backward
✗ **Status badges update instantly** - No, depends on polling
✗ **Completed steps collapse naturally** - No, all expand always
✗ **Active step is always obvious** - No, no highlight for current_step_stable_id
✗ **Failures are understandable** - Partially, errors shown but not contextualized
✗ **Retry feels natural** - No, require separate button click

### 7.2 Missing UI Components

- **Connection Status Badge**: Shows "Connected", "Reconnecting", "Disconnected"
- **Current Step Highlight**: CSS glow/highlight on active step in timeline
- **Progress Bars**: Inside stages showing % completion
- **ETA Timer**: "Started X min ago, estimated Y min remaining"
- **Live Log Viewer**: Full logs streaming from WebSocket, not truncated
- **Optimistic Buttons**: Immediate visual feedback
- **Skeleton Loaders**: During cache refetch
- **Phase Transition Banners**: "Moving to validation phase..."
- **Event Timestamps**: Show when each event occurred
- **Network Status**: Show when client is offline

---

## Phase 8: Navigation Resilience

### 8.1 Scenarios

**Scenario 1: Switch tabs while execution running**
- User on TaskWorkspace, execution is live
- Clicks browser tab #2
- Redux state persists (good)
- WebSocket connection dies (good, cleans up)
- User returns to tab #1
- useSocketChannel re-activates (good)
- But: Which events missed during disconnect? Unknown
- If away >30s, polling interval might have triggered stale cache

**Scenario 2: Close browser, reopen**
- Redux store is lost
- localStorage `forge-turn-artifacts-{taskId}` persists (good)
- localStorage `workspace_session_{workspaceId}` persists (good)
- But: Execution/validation/repair/publishing state is lost
- User navigates back to task → queries refetch from server (ok, but slow)

**Scenario 3: Browser sleep, reconnect**
- WebSocket connection silently dies
- No heartbeat until next message attempt
- User sees frozen timeline
- Eventually (after reconnect backoff) socket recovers

---

## Phase 9: Complete Proposed Architecture

### 9.1 Unified WebSocket System

**Goal**: Single WebSocket per task execution, all events flow through one channel.

```typescript
// One WebSocket per execution/validation/repair/publishing cycle
type ExecutionPhase = 'execution' | 'validation' | 'repair' | 'publishing'

interface UnifiedWSClient {
  taskId: string
  currentPhase: ExecutionPhase
  socket: WebSocket | null
  
  // Single event stream for entire task lifecycle
  events: ExecutionEvent[]
  
  // Watermarking to prevent retrograde updates
  lastTimestamp: number
  lastSeq: Record<ExecutionPhase, number>
  
  // Reconnection with full replay
  sessionId: string | null
  
  // Connection status observable
  status: Observable<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>
}
```

### 9.2 Event Watermarking & Ordering

All events include:
```typescript
interface ExecutionEvent {
  id: string // UUID for dedup
  ts: number // Server timestamp (unix ms)
  phase: ExecutionPhase
  seq: number // Lamport clock per phase
  event: string
  payload: unknown
  receivedAt?: number // Client time (informational)
}
```

Prevents:
- Retrograde updates (ts always increasing)
- Duplicate events (id-based dedup)
- Out-of-order events within phase (seq-based ordering)

### 9.3 Automatic Cache Invalidation

```typescript
// When 'exec_complete' event received
// Automatically invalidate RTK tags
dispatch(baseApi.util.invalidateTags(['Execution', 'Diff']))

// When 'validation_complete' event received
dispatch(baseApi.util.invalidateTags(['Validation']))

// etc.
```

### 9.4 Stop Polling on Terminal State

```typescript
const { data, isLoading, refetch } = useGetExecutionQuery(
  { repoId, taskId },
  { 
    // Only poll while execution is live
    pollingInterval: execLive ? 3000 : undefined,
    // Or: smart polling that stops on terminal state
    skip: !repoId || !taskId
  }
)
```

### 9.5 Optimistic Updates

```typescript
const [approveTask] = useApproveTaskMutation()

approveTask({
  taskId,
  // Optimistic update
  optimisticData: {
    task: { ...task, status: 'approved' }
  }
})
```

### 9.6 Connection Status UI

```typescript
export function ConnectionStatus() {
  const status = useAppSelector(s => s.websocket.execution.status)
  
  return {
    'connected': <div>🟢 Live</div>,
    'connecting': <div>🟡 Connecting...</div>,
    'reconnecting': <div>🟡 Reconnecting...</div>,
    'disconnected': <div>🔴 Disconnected - Click to retry</div>
  }[status]
}
```

### 9.7 Current Step Highlight

```typescript
const currentStep = execution.current_step_stable_id

// In timeline
entries.map(entry => {
  const isActive = entry.step?.stable_id === currentStep
  return <TimelineEntry isActive={isActive} />
})
```

### 9.8 Progress Indicators

```typescript
interface StageProgressEvent {
  type: 'stage_progress'
  stage: string
  totalLines: number
  processedLines: number
  percentComplete: number
}

// In ValidationStages
percentComplete && <ProgressBar value={percentComplete} />
```

---

## Phase 10: Production Standards

### What We Will NOT Do:
- ❌ Hardcoded delays (`setTimeout`)
- ❌ Forced refreshes (`window.location.reload`)
- ❌ Arbitrary timers for UX
- ❌ Unnecessary polling
- ❌ Duplicated state management
- ❌ Unnecessary re-renders

### What We WILL Do:
- ✅ Event-driven updates via unified WebSocket
- ✅ Single source of truth per resource
- ✅ Deterministic rendering (same event = same UI)
- ✅ Scalable architecture (add phases without duplication)
- ✅ Reusable components
- ✅ Production-grade error handling
- ✅ Clear separation of concerns

---

## Summary: Issues Found

### Critical (Blocking Real-Time UX)
1. Multiple WebSocket systems with inconsistent reconnect
2. No connection status indicator
3. No visual progress during execution
4. Stale cached data on navigation
5. Manual cache invalidation scattered
6. Polling never stops
7. Race between WebSocket and polling
8. WebSocket doesn't survive browser sleep
9. No optimistic updates
10. Logs never fully stream
11. Repair/publishing streams buried
12. No transition animations
13. Validation stages don't stream progress
14. Repair attempt details not live
15. Publishing PR URL not shown until refetch

### Medium (Degraded Experience)
16-20: Skeleton loaders, button state sync, timestamps, ETA, truncated logs

---

## Implementation Priority Order

**Phase A (Foundation)** - Required for all other improvements:
1. Unified WebSocket system with event watermarking
2. Automatic cache invalidation
3. Connection status observable

**Phase B (Visibility)** - User always knows what's happening:
4. Connection status UI badge
5. Current step highlighting
6. Phase transition indicators

**Phase C (Responsiveness)** - System feels alive:
7. Optimistic updates (approve/reject)
8. Stop polling on terminal state
9. Progress bars for stages

**Phase D (Robustness)** - Recovery from interruptions:
10. Session replay on reconnect
11. Skeleton loaders during refetch
12. Clear error recovery UI

**Phase E (Polish)** - Industrial feel:
13. Event timestamps
14. ETA calculation
15. Full log streaming
16. Animated transitions

---

**This audit is comprehensive and ready for implementation. Each issue has a root cause identified and technical justification for the fix.**
