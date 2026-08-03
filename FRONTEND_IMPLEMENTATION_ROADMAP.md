# Frontend Implementation Roadmap – Real-Time UX Overhaul

**Status:** Backend is production-ready. Frontend needs optimization to use backend capabilities.

**Scope:** 5 phases, all frontend-only, can run independently.

---

## PHASE 1: Unified WebSocket Architecture

**Objective:** Replace 4 separate WebSocket streams with 1 unified stream using channel subscriptions.

**What breaks:** `useExecutionStream`, `useValidationStream`, `useRepairStream`, `usePublishingStream`

**What's built:** `useUnifiedStream` hook connecting to `/workspaces/{workspaceID}/stream`

### Files to Create
- `src/hooks/useUnifiedStream.ts` – Single WebSocket manager with reconnect
- `src/services/streaming/UnifiedStreamClient.ts` – Channel subscription logic
- `src/store/slices/streamSlice.ts` (refactor) – Updated to handle unified envelope format

### Files to Update
- `src/store/middleware/websocketMiddleware.ts` – Route unified events to correct reducers
- `src/features/task-workspace/*.tsx` – Use unified hooks instead of separate ones
- `src/types/websocket.ts` – Add `seq`, `ts`, `id`, `phase` to event types

### Expected Outcome
- Single persistent WS per workspace
- Channel filtering reduces message volume
- Reconnect time reduced from ~2s to ~100ms (no full replay needed)
- Baseline: Can complete this without touching backend

---

## PHASE 2: Event Timeline with Full Metadata

**Objective:** Store and display events with complete metadata (seq, ts, id, phase).

**What breaks:** Timeline currently shows only message text

**What's built:**
- Events stored with full envelope in Redux
- Timeline sorted by `seq` (not ts, to handle out-of-order arrivals)
- Each event shows: `[HH:MM:SS] Message` with hover showing full details
- Duplicate detection using `id` field

### Files to Create
- `src/features/task-workspace/EventTimeline.tsx` – Sorted event display
- `src/hooks/useEventMetadata.ts` – Extract metadata from envelope

### Files to Update
- `src/store/slices/streamSlice.ts` – Store full envelope, not just text
- `src/types/execution.ts`, `validation.ts`, `repair.ts`, `publishing.ts` – Add metadata fields

### Expected Outcome
- Users see real timestamps on events (not guessed from arrival time)
- Phase transitions are visible (phase field indicates which phase event belongs to)
- Events sorted consistently regardless of network jitter
- Baseline: Can do this with current architecture

---

## PHASE 3: Session Replay Protocol

**Objective:** Implement gap-fill reconnect (send `last_seq` per channel, get only new events).

**What breaks:** Current reconnect sends full replay

**What's built:**
- On disconnect, save `last_seq` per channel to sessionStorage
- On reconnect, send: `{ type: "reconnect", session_id, last_seq }`
- Receive only events after last_seq for each channel
- Clear saved state when full replay completes

### Files to Create
- `src/services/streaming/SessionStorage.ts` – Persist/restore last_seq
- `src/hooks/useSessionReplay.ts` – Handle reconnect sequence

### Files to Update
- `src/services/streaming/UnifiedStreamClient.ts` – Send last_seq on reconnect
- `src/store/slices/streamSlice.ts` – Track last_seq per channel

### Expected Outcome
- Reconnect payload 75% smaller (only gap-fill, not full history)
- Reconnect completes 10-50x faster depending on history size
- Baseline: No backend changes (backend already supports this)

---

## PHASE 4: Remove REST Polling, Enable WebSocket-Only Mode

**Objective:** Eliminate polling queries, rely 100% on WebSocket for real-time updates.

**What breaks:** `useGetExecutionQuery`, `useGetValidationQuery`, `useGetRepairSessionByTaskQuery` polling

**What's built:**
- `useExecutionSnapshot()` – Combines initial REST fetch + WS updates
- `useValidationSnapshot()` – Combines initial REST fetch + WS updates
- `useRepairSnapshot()` – Combines initial REST fetch + WS updates
- Polling only for initial load, zero polling after

### Files to Delete
- Remove polling configuration from RTK query setup
- Remove `polling_interval_ms` from queries

### Files to Update
- `src/hooks/useExecution.ts` – Use WS after initial load
- `src/hooks/useValidation.ts` – Use WS after initial load
- `src/hooks/useRepair.ts` – Use WS after initial load
- `src/services/api/baseApi.ts` – Disable polling for these domains

### Expected Outcome
- No unnecessary network requests after execution starts
- CPU/memory lower (no timer callbacks)
- Backend sees 50% fewer requests
- Real-time updates purely from WebSocket
- Baseline: Requires Phase 1 (unified WS)

---

## PHASE 5: Optimistic Updates + Progressive Rendering

**Objective:** Immediate UI feedback for user actions, progressive log streaming.

**What breaks:** Approval button currently disables pending backend response

**What's built:**
- Approve button: immediately mark as approved, disable button, disable pending
- Reject button: immediately mark as rejected, show status
- Validation stage: immediately show as active when `stage_started` event arrives
- Log streaming: render partial logs as they arrive (not wait for full block)
- Phase transitions: Animate when phase field changes

### Files to Create
- `src/features/task-workspace/OptimisticActions.tsx` – Button state handlers
- `src/hooks/useOptimisticUpdate.ts` – Generic optimistic update pattern
- `src/features/task-workspace/ProgressiveLogRenderer.tsx` – Stream logs line-by-line

### Files to Update
- `src/features/task-workspace/ActionButtons.tsx` – Use optimistic updates
- `src/features/task-workspace/ValidationStages.tsx` – Show stage as running
- `src/features/task-workspace/MissionThread.tsx` – Stream logs progressively
- `src/store/slices/taskSlice.ts` – Support rollback on error

### Expected Outcome
- Approve button feels instant (0ms instead of 300-500ms)
- Validation progress visible immediately as diagnostics stream in
- Logs appear continuously, not in chunks
- Better perceived performance (response feels immediate)
- Baseline: Can do this with current WS, enhanced with Phase 1

---

## PHASE 6: Connection Status Visibility (BONUS)

**Objective:** Users always know connection state (Live / Connecting / Reconnecting / Offline).

**What's built:**
- Badge shows connection state: "Live ✓" / "Connecting..." / "Reconnecting..." / "Offline ✗"
- Badge color: green / yellow / yellow / red
- When offline, show "Buffering updates" message
- Resume automatically when connection restored

### Files to Create
- `src/features/task-workspace/ConnectionStatus.tsx` – Status badge
- `src/hooks/useConnectionStatus.ts` – Track WS state

### Files to Update
- `src/services/streaming/UnifiedStreamClient.ts` – Emit connection state changes
- `src/store/slices/streamSlice.ts` – Store connection state
- `src/features/task-workspace/TaskWorkspace.tsx` – Render badge

### Expected Outcome
- Users never confused about why events stopped arriving
- Clear visual distinction between "not ready yet" vs "connection lost"
- Baseline: Straightforward with Phase 1

---

## IMPLEMENTATION PRIORITY

### Tier 1: Must-do (Unlocks everything else)
1. **Phase 1: Unified WebSocket** – Single source of connection, enables all other work

### Tier 2: High-impact, quick wins
2. **Phase 2: Event Timeline** – Users see real timestamps, debugging easier
3. **Phase 4: Remove REST Polling** – Immediately reduces server load
4. **Phase 6: Connection Status** – Transparency, reduced support requests

### Tier 3: Polish
5. **Phase 3: Session Replay** – Faster reconnect (UX sugar)
6. **Phase 5: Optimistic Updates** – Better perceived performance

---

## TASK BREAKDOWN

### Sprint 1: Unified WebSocket (2 days)
- [ ] `UnifiedStreamClient.ts` – WebSocket lifecycle
- [ ] `useUnifiedStream.ts` – React hook
- [ ] Update Redux middleware to route events
- [ ] Verify all 4 phases receive events
- [ ] Test reconnect behavior

### Sprint 2: Event Metadata (1 day)
- [ ] Update TypeScript types (seq, ts, id, phase)
- [ ] Update Redux to store full envelope
- [ ] Update timeline UI to display metadata
- [ ] Fix event ordering by seq not arrival time

### Sprint 3: Remove Polling (1 day)
- [ ] Identify all polling queries
- [ ] Disable RTK polling
- [ ] Verify WebSocket drives all updates
- [ ] Monitor network tab for polling requests

### Sprint 4: Optimistic Updates (1.5 days)
- [ ] Approval/rejection buttons
- [ ] Validation stage active state
- [ ] Progressive log rendering
- [ ] Rollback on error

### Sprint 5: Session Replay (1 day)
- [ ] Save last_seq on disconnect
- [ ] Send last_seq on reconnect
- [ ] Verify gap-fill working
- [ ] Benchmark: before/after reconnect time

### Sprint 6: Connection Status (0.5 days)
- [ ] Connection state tracking
- [ ] Badge component
- [ ] Color coding
- [ ] Offline state message

---

## SUCCESS CRITERIA

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| Manual refreshes needed | Often | Never | Zero |
| Connection clarity | Hidden | Always visible | 100% uptime shown |
| Progress indication | Binary | Live updates | >10 events/sec |
| Stale data risk | High | Eliminated | Verified |
| Reconnect time | 1-3 seconds | 100ms | <200ms |
| Polling requests/min | 5-10 | 0 | Zero |
| Button responsiveness | 300-500ms | Instant | <50ms perceived |
| Log streaming | Chunks | Progressive | Continuous |

---

## ROLLOUT STRATEGY

### Day 1-2: Phase 1 + 2 in feature branch
- Unified WS + event metadata
- Test in preview
- Verify no regressions

### Day 3: Phase 4 on main branch
- Remove polling
- Push to production
- Monitor server load

### Day 4-5: Phase 5 + 6
- Optimistic updates + connection status
- Polish and release

### Day 6: Phase 3 (session replay)
- Gap-fill reconnect
- Performance profiling

---

## RISKS & MITIGATIONS

### Risk: Breaking existing clients
**Mitigation:** Feature-flag unified WS, roll out gradually

### Risk: Event ordering issues
**Mitigation:** Sort by seq, test with 1000+ concurrent clients

### Risk: Polling removal breaks something
**Mitigation:** Use feature flag, keep polling code, disable by env var

### Risk: Optimistic update rollback cascades
**Mitigation:** Clear rollback logic, test error scenarios

---

## BACKEND CHANGES NEEDED

**NONE.** All work is frontend-only.

Backend is already production-ready with:
- Unified event envelope with seq/ts/id/phase
- Single WebSocket with channel subscriptions
- Durable replay with gap-fill
- Session grace period (5 minutes)
- Automatic reconnect handling

Frontend just needs to use these capabilities.

