# Phase 1: Ready to Start – Frontend Unified WebSocket Architecture

**Status:** Analysis complete. Backend is production-ready. Frontend work ready to begin.

---

## What We Discovered

### Backend (Go) – Exceptional ✅

The backend implements **all infrastructure needed for world-class real-time UX:**

- ✅ **Unified event envelope** with id, ts, seq, phase (no changes needed)
- ✅ **Single WebSocket per workspace** with channel subscriptions (no changes needed)
- ✅ **Durable event storage** in PostgreSQL (no changes needed)
- ✅ **In-memory ring buffer** for fast replay (no changes needed)
- ✅ **Session grace period** (5 minutes for reconnect) (no changes needed)
- ✅ **Gap-fill replay** (send only events after last_seq) (no changes needed)
- ✅ **Collision resolution** for multi-instance deployments (no changes needed)

**Conclusion:** Backend is feature-complete. Zero changes required.

### Frontend (TypeScript/React) – Sub-optimal ❌

The frontend is not using backend capabilities:

- ❌ Opens **4 separate WebSockets** instead of 1 (execution, validation, repair, publishing)
- ❌ **Event types missing metadata** (no seq, ts, id, phase captured)
- ❌ **No session reconnect tracking** (sends full replay instead of gap-fill)
- ❌ **REST polling still active** (wastes bandwidth, creates cache conflicts)
- ❌ **No optimistic updates** (buttons feel slow)
- ❌ **No connection status visibility** (users don't know if offline)

**Conclusion:** Frontend needs overhaul to use backend capabilities.

---

## What Users Will Experience After Phase 1

### Before (Today)

1. Task execution starts
2. Browser opens separate WS for execution
3. Events trickle in but timeline feels disjointed
4. If network hiccups → full page refresh needed
5. Approve button unresponsive for 300-500ms
6. Validation runs silently with no progress indication
7. Logs appear in chunks with timestamps missing

### After Phase 1 Complete

1. Task execution starts
2. Browser opens **one unified WS** and subscribes to all channels
3. Events flow coherently with consistent ordering (by seq)
4. Network hiccup → **auto-reconnect in 100ms** with gap-fill
5. Approve button **instantly responsive** (optimistic update)
6. Validation shows **live progress** as diagnostics arrive
7. Logs stream **continuously with accurate timestamps**
8. Users see **connection status badge** (Live / Reconnecting / Offline)

---

## What Phase 1 Involves

### Architecture Change

**Before:**
```
Frontend                          Backend
  ├─ WebSocket: execution    ───→  Channel: execution
  ├─ WebSocket: validation   ───→  Channel: validation  
  ├─ WebSocket: repair       ───→  Channel: repair
  └─ WebSocket: publishing   ───→  Channel: publishing
```

**After:**
```
Frontend                          Backend
  └─ WebSocket: unified ─ subscribe → execution
                        ├─→ validation
                        ├─→ repair
                        └─→ publishing
```

### Implementation Scope

#### NEW FILES
1. `src/services/streaming/UnifiedStreamClient.ts` – WebSocket lifecycle + channel management
2. `src/hooks/useUnifiedStream.ts` – React hook for unified stream
3. `src/services/streaming/SessionStorage.ts` – Persist/restore session state

#### UPDATED FILES
1. `src/store/middleware/websocketMiddleware.ts` – Route unified events to correct reducers
2. `src/store/slices/streamSlice.ts` – Handle unified envelope format
3. `src/types/websocket.ts` – Add seq, ts, id, phase to event types
4. `src/features/task-workspace/*.tsx` – Replace 4 hooks with 1 unified hook
5. `src/services/api/*.ts` – Remove polling configuration

#### DELETED FILES
1. Legacy WebSocket implementations (if any duplicates exist)
2. Polling configuration for execution/validation/repair/publishing

### Effort Estimate

- **Design & planning:** 2 hours
- **Core implementation:** 8 hours
- **Integration & testing:** 6 hours
- **Documentation & cleanup:** 2 hours
- **Total:** ~18 hours (2.5 developer days)

### Risk Level: LOW

- Backend doesn't change
- Gradual rollout possible (feature flag)
- Rollback simple (switch back to 4 WebSockets)
- No database migrations
- No API contract changes

---

## Success Metrics (Phase 1 Only)

| Metric | Target | How Measured |
|--------|--------|--------------|
| Single WS per workspace | 100% | Browser devtools: 1 WS open |
| Event seq ordering | 100% accurate | All seq numbers monotonic |
| Reconnect latency | <200ms | Network tab + timing |
| Reconnect payload | <10KB | Network tab bytes transferred |
| No event loss | 100% | Compare seq sequence (no gaps) |
| Type safety | All metadata captured | TypeScript compilation zero errors |

---

## Dependencies

### On Backend
None. Backend is already production-ready.

### On Other Frontend Work
- Phase 2 (Event Timeline) depends on Phase 1 ✓
- Phase 3 (Session Replay) depends on Phase 1 ✓
- Phase 4 (Remove Polling) depends on Phase 1 ✓
- Phase 5 (Optimistic Updates) enhances Phase 1 ✓
- Phase 6 (Connection Status) enhances Phase 1 ✓

### On Third-Party
None.

---

## Rollout Strategy

### Week 1: Development
- Implement `UnifiedStreamClient.ts`
- Implement `useUnifiedStream.ts`
- Update Redux middleware
- Local testing

### Week 2: Testing
- Integration testing (all 4 phases simultaneously)
- Reconnect scenarios (simulate network loss)
- Concurrent client testing
- Feature-flag to toggle on/off

### Week 3: Gradual Rollout
- Deploy to staging
- Load test (1000+ concurrent clients)
- Rollout to 10% of production
- Monitor for 24 hours
- Rollout to 50%
- Monitor for 24 hours
- Full rollout to 100%

### Week 4: Validation + Iteration
- User feedback gathering
- Performance profiling
- Bug fixes
- Documentation for team

---

## Blockers / Questions Before Starting

1. **Feature flags available?** (Need to toggle unified WS on/off per user)
   - Recommendation: Use environment variable + Redux feature flag
   - Fallback: Manual code toggle

2. **Any existing code that depends on separate WebSocket instances?**
   - Recommendation: Grep for `useExecutionStream`, `useValidationStream`, etc.
   - Provide migration guide

3. **How do we handle existing browser sessions with old WebSocket?**
   - Recommendation: Let them stay connected; new connections use unified WS
   - Old connections will eventually disconnect (5-min grace period)

4. **Monitoring setup?**
   - Recommendation: Track WebSocket connection events in analytics
   - Alert if connection failures exceed 5%

---

## Next Steps

1. ✅ **Read the three analysis documents:**
   - `BACKEND_ANALYSIS.md` – What the backend provides
   - `BACKEND_QUESTIONS_ANSWERED.md` – Answers to 7 architecture questions
   - `FRONTEND_IMPLEMENTATION_ROADMAP.md` – Complete 6-phase roadmap

2. **Schedule Phase 1 kickoff meeting** with:
   - Frontend lead
   - DevOps (for feature flags)
   - Product (for rollout timeline)
   - QA (for testing strategy)

3. **Create Phase 1 tickets:**
   - T1: `UnifiedStreamClient.ts` implementation
   - T2: `useUnifiedStream.ts` hook
   - T3: Redux middleware updates
   - T4: Type updates
   - T5: Integration testing
   - T6: Feature flag + deployment

4. **Assign developer:**
   - Recommend: Someone familiar with WebSocket lifecycle + Redux
   - Level: Senior/mid-level (not entry-level)

5. **Begin implementation** (estimated 2-3 weeks for Phase 1)

---

## Decision Point

**Question for stakeholders:**

Would you like v0 to begin implementation of Phase 1 (Unified WebSocket) immediately?

### Option A: Yes, start now
- v0 creates `UnifiedStreamClient.ts` and related files
- v0 integrates with existing Redux setup
- v0 provides PR ready for review in 3-5 days

### Option B: Yes, but prepare first
- v0 creates detailed technical design document
- v0 creates migration guide for existing code
- Team reviews + approves design
- Then v0 begins implementation

### Option C: No, defer to later
- v0 creates standalone reference implementation in separate branch
- Team can review at leisure
- Start implementation when ready

---

## Documents Provided

1. **ARCHITECTURE_AUDIT.md** (876 lines)
   - Complete forensic analysis of frontend issues
   - 15 critical issues identified with root causes
   - Comparative analysis vs GitHub Actions, Vercel, Linear

2. **BACKEND_ANALYSIS.md** (421 lines)
   - Complete Go backend architecture review
   - Answers: What backend provides, what frontend must use
   - No backend changes needed

3. **BACKEND_QUESTIONS_ANSWERED.md** (595 lines)
   - Detailed answer to all 7 architecture questions
   - Evidence from source code
   - Trade-offs and recommendations

4. **FRONTEND_IMPLEMENTATION_ROADMAP.md** (303 lines)
   - 6-phase implementation plan
   - Phase breakdown: effort, files, dependencies
   - Success metrics and rollout strategy

5. **PHASE_1_READY.md** (this document)
   - Executive summary
   - What changes, why, and when
   - Decision point for stakeholders

---

## Contact & Follow-up

**For questions about:**
- Backend capabilities → See BACKEND_ANALYSIS.md
- Architecture decisions → See BACKEND_QUESTIONS_ANSWERED.md
- Implementation details → See FRONTEND_IMPLEMENTATION_ROADMAP.md
- Issues/bugs to fix → See ARCHITECTURE_AUDIT.md

**Ready to start Phase 1?** Let's build it.

