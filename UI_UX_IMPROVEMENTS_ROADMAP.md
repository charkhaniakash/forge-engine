# UI/UX Improvements Roadmap

Now that real-time updates are working robustly, here are recommended enhancements to make the UI more visually compelling and user-friendly.

## Quick Wins (1-2 hours each)

### 1. Connection Status Indicator
**Problem**: Users don't know if WebSocket is connected or if system is using polling fallback.
**Solution**: Add a badge in the header showing connection status.

```typescript
// TaskWorkspace.tsx header section
const connectionState = useAppSelector(s => s.websocket[...].state)

<div className={styles.headerRight}>
  {connectionState === 'open' ? (
    <span className={styles.connectedBadge}>
      <span className={styles.dot} /> Live
    </span>
  ) : connectionState === 'reconnecting' ? (
    <span className={styles.reconnectingBadge}>
      <Spinner size={12} /> Reconnecting...
    </span>
  ) : (
    <span className={styles.offlineBadge}>
      ⚠️ Offline (polling)
    </span>
  )}
</div>
```

**CSS**:
```css
.connectedBadge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: #10b981;
  color: white;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: white;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

**Benefit**: Users instantly see system status without confusion.

---

### 2. "Updated X seconds ago" Timestamp
**Problem**: Users don't know when data was last refreshed.
**Solution**: Add timestamps to data cards showing freshness.

```typescript
// MissionThread.tsx or ArtifactCard.tsx
const [lastUpdateTime, setLastUpdateTime] = useState<number>(Date.now())

useEffect(() => {
  setLastUpdateTime(Date.now())
}, [data]) // Update when data changes

const secondsAgo = Math.floor((Date.now() - lastUpdateTime) / 1000)
const timeLabel = secondsAgo < 60 
  ? `${secondsAgo}s ago`
  : `${Math.floor(secondsAgo / 60)}m ago`

<div className={styles.artifactHeader}>
  <h3>{title}</h3>
  <span className={styles.freshness}>{timeLabel}</span>
</div>
```

**CSS**:
```css
.freshness {
  font-size: 11px;
  color: #9ca3af;
  padding: 4px 8px;
  background: #f3f4f6;
  border-radius: 6px;
}
```

**Benefit**: Users see data is fresh and updating in real-time.

---

### 3. Progress Counters During Validation/Repair
**Problem**: Multi-stage processes feel slow without progress feedback.
**Solution**: Show "3/5 stages complete" style counters.

```typescript
// ValidationStages.tsx or RepairAttemptCard.tsx
const completedCount = stages.filter(s => s.state === 'passed').length
const totalCount = stages.length

<div className={styles.progress}>
  <div className={styles.progressBar}>
    <div 
      className={styles.progressFill}
      style={{ width: `${(completedCount / totalCount) * 100}%` }}
    />
  </div>
  <span className={styles.progressText}>
    {completedCount}/{totalCount} stages
  </span>
</div>
```

**CSS**:
```css
.progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progressBar {
  flex: 1;
  height: 6px;
  background: #e5e7eb;
  border-radius: 3px;
  overflow: hidden;
}

.progressFill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #2563eb);
  transition: width 0.3s ease;
}

.progressText {
  font-size: 12px;
  color: #6b7280;
  white-space: nowrap;
}
```

**Benefit**: Users see progress and feel updates happening in real-time.

---

### 4. Smooth State Transitions
**Problem**: UI changes feel abrupt when phases complete.
**Solution**: Add fade/slide animations to state transitions.

```css
@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.artifactCard {
  animation: slideIn 0.3s ease-out;
}

/* For list items */
.entry {
  animation: slideIn 0.3s ease-out;
  animation-fill-mode: both;
}

.entry:nth-child(1) { animation-delay: 0ms; }
.entry:nth-child(2) { animation-delay: 50ms; }
.entry:nth-child(3) { animation-delay: 100ms; }
```

**Benefit**: Smoother visual feedback, feels more responsive.

---

### 5. Skeleton Loaders for Data Refresh
**Problem**: Blank screens when data refetches mid-update.
**Solution**: Show skeleton placeholders during refetch.

```typescript
// ArtifactCard.tsx
const { data, isFetching } = useGetValidationQuery(...)

if (isFetching && !data) {
  return (
    <div className={styles.artifactCard}>
      <Skeleton height={40} />
      <Skeleton height={200} />
    </div>
  )
}
```

**CSS**:
```css
.skeleton {
  background: linear-gradient(
    90deg,
    #f3f4f6 25%,
    #e5e7eb 50%,
    #f3f4f6 75%
  );
  background-size: 200% 100%;
  animation: shimmer 2s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

**Benefit**: Better perceived performance, no blank spaces.

---

### 6. Error Toast with Retry
**Problem**: Users don't know when data fetch fails, no recovery path.
**Solution**: Show error toasts with automatic retry.

```typescript
// In useToast or error boundary
function showRefreshError(tagName: string) {
  toast.error(
    `Failed to update ${tagName}`,
    {
      action: {
        label: 'Retry',
        onClick: () => {
          store.dispatch(baseApi.util.invalidateTags([tagName]))
          toast.info('Refreshing...')
        }
      },
      duration: 5000,
    }
  )
}

// In error callback:
const { data, error, refetch } = useGetValidationQuery(..., {
  onError: (err) => {
    showRefreshError('Validation')
    // Auto-retry after 3 seconds
    setTimeout(() => refetch(), 3000)
  }
})
```

**Benefit**: Users know when something fails and can retry manually or wait for auto-retry.

---

## Medium Effort (3-5 hours each)

### 7. Smart Polling Badge
Show users when system switched to polling fallback.

```typescript
const isPolling = connectionState !== 'open' && pollingInterval > 0

<div className={styles.statusBar}>
  {isPolling && (
    <div className={styles.pollingNotice}>
      📡 Using polling (connection unstable)
    </div>
  )}
</div>
```

---

### 8. Activity Timeline
Show a timeline of all events during execution.

```typescript
// New component: ActivityTimeline.tsx
export function ActivityTimeline({ events }: { events: SocketEvent[] }) {
  return (
    <div className={styles.timeline}>
      {events.map((event, i) => (
        <div key={event.id} className={styles.timelineItem}>
          <div className={styles.dot} />
          <div className={styles.content}>
            <span className={styles.time}>{formatTime(event.timestamp)}</span>
            <span className={styles.message}>{event.message}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
```

---

### 9. Visual Execution Status Map
Show execution steps as a visual map with status indicators.

```typescript
// ExecutionMap.tsx
export function ExecutionMap({ steps }: { steps: ExecutionStep[] }) {
  return (
    <div className={styles.map}>
      {steps.map((step, i) => (
        <div key={step.id} className={`${styles.step} ${styles[step.status]}`}>
          <div className={styles.stepNumber}>{i + 1}</div>
          <div className={styles.stepLabel}>{step.name}</div>
          {step.status === 'running' && <Spinner size={16} />}
        </div>
      ))}
    </div>
  )
}
```

---

### 10. Real-Time Log Viewer
Show live logs updating as they stream.

```typescript
// LiveLogViewer.tsx
export function LiveLogViewer({ logs }: { logs: WorkspaceLog[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  
  useEffect(() => {
    // Auto-scroll to bottom when new logs arrive
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div className={styles.logViewer}>
      {logs.map((log, i) => (
        <div key={log.id} className={`${styles.logLine} ${styles[log.level]}`}>
          <span className={styles.timestamp}>{formatTime(log.timestamp)}</span>
          <span className={styles.message}>{log.message}</span>
        </div>
      ))}
      <div ref={scrollRef} />
    </div>
  )
}
```

---

## Higher Effort (Half day+ each)

### 11. Optimistic Updates
Show changes optimistically before confirmation.

```typescript
// Before: Click button → Wait for response → See update
// After: Click button → See update instantly → Wait for confirmation

const [optimisticData, setOptimisticData] = useState(null)

const handleApprove = async () => {
  setOptimisticData({ status: 'approved' })
  try {
    await approve({ repoId, taskId }).unwrap()
  } catch {
    setOptimisticData(null) // Revert on error
  }
}
```

---

### 12. Collaborative Features
Show when other team members view the same task.

```typescript
// Would require backend support for user presence
// UI: Show avatars of users viewing current task
// Notify when someone else approves/modifies
```

---

## Design System Updates

### New CSS Classes to Add to MissionThread.module.css

```css
/* Connection Status */
.connectedBadge { /* ... */ }
.reconnectingBadge { /* ... */ }
.offlineBadge { /* ... */ }

/* Progress */
.progressBar { /* ... */ }
.progressFill { /* ... */ }

/* Timestamps */
.freshness { /* ... */ }
.lastUpdated { /* ... */ }

/* Animations */
@keyframes slideIn { /* ... */ }
@keyframes shimmer { /* ... */ }
@keyframes pulse { /* ... */ }

/* Feedback */
.errorBanner { /* ... */ }
.successBanner { /* ... */ }
.infoBanner { /* ... */ }
```

---

## Implementation Priority

**Phase 1 (This Week)** - Visibility & Feedback
- [ ] Connection status indicator
- [ ] Updated X seconds ago timestamp
- [ ] Progress counters

**Phase 2 (Next Week)** - Polish & Animations
- [ ] Smooth state transitions
- [ ] Skeleton loaders
- [ ] Error toasts with retry

**Phase 3 (Following Week)** - Advanced Features
- [ ] Smart polling badge
- [ ] Activity timeline
- [ ] Real-time log viewer
- [ ] Execution status map

**Phase 4 (Later)** - Premium Features
- [ ] Optimistic updates
- [ ] Collaborative features

---

## Expected Impact

| Feature | UX Impact | Implementation Time |
|---|---|---|
| Connection Badge | 🟢 High | 30 min |
| Freshness Timestamps | 🟢 High | 30 min |
| Progress Counters | 🟢 High | 45 min |
| Smooth Transitions | 🟡 Medium | 1 hour |
| Skeleton Loaders | 🟢 High | 1 hour |
| Error Toasts | 🟡 Medium | 1 hour |
| Timeline | 🟡 Medium | 2 hours |
| Status Map | 🟡 Medium | 2 hours |

---

## CSS Patterns Reference

All new components should follow these patterns:

```typescript
// Use semantic HTML
<header>, <main>, <section>, <article>

// Use Tailwind + CSS modules
className={`${styles.component} text-sm font-medium`}

// Use CSS Grid or Flexbox
display: flex | grid

// Animations should be subtle
transition: all 0.3s ease

// Colors from design tokens
background: var(--color-primary)

// Mobile-first responsive design
// Mobile defaults, then md:, lg:, xl: prefixes
```

---

## Next Steps

1. Review this roadmap with the team
2. Pick Phase 1 features to implement
3. Create tickets for each feature
4. Assign to frontend team members
5. Follow this guide for consistent implementation

Let's make this UI shine! 🚀
