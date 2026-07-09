import { useEffect, useRef } from 'react'
import type { ActivityEvent, ActivityKind } from './model'
import styles from './ActivityFeed.module.css'

export interface ActivityFeedProps {
  events: ActivityEvent[]
  /** Show a blinking cursor + "working" affordance at the tail. */
  live?: boolean
  emptyLabel?: string
}

/** Emoji marker for an event, matching the "watching an engineer" language. */
function marker(ev: ActivityEvent): string {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_result') {
    const t = (ev.tool ?? '').toLowerCase()
    if (t.includes('read')) return '📖'
    if (t.includes('write') || t.includes('create') || t.includes('edit')) return '✏️'
    if (t.includes('search') || t.includes('grep') || t.includes('symbol')) return '🔍'
    if (t.includes('list') || t.includes('dir') || t.includes('ls')) return '📁'
    if (t.includes('delete') || t.includes('remove')) return '🗑️'
    if (t.includes('valid') || t.includes('build') || t.includes('test') || t.includes('run')) return '🧪'
    return '🔧'
  }
  const byKind: Record<ActivityKind, string> = {
    status: '●',
    reasoning: '💭',
    tool_call: '🔧',
    tool_result: '🔧',
    validation: '🧪',
    repair: '🩹',
    diff: '📝',
    error: '❌',
  }
  return byKind[ev.kind]
}

function Outcome({ outcome }: { outcome: ActivityEvent['outcome'] }) {
  if (!outcome) return null
  if (outcome === 'running') return <span className={styles.spinner} aria-label="running" />
  if (outcome === 'ok') return <span className={`${styles.outcome} ${styles.ok}`}>✓</span>
  return <span className={`${styles.outcome} ${styles.fail}`}>✗</span>
}

/**
 * Terminal-style unified live feed. Renders the normalized event stream —
 * reasoning, tool calls/results, validation and repair milestones — as one
 * chronological log, the way Claude Code / Devin surface agent activity.
 */
export function ActivityFeed({ events, live = false, emptyLabel = 'Waiting for the agent…' }: ActivityFeedProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-follow only when the user is already pinned to the bottom.
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <div className={styles.feed} ref={scrollRef} onScroll={onScroll}>
      {events.length === 0 && <div className={styles.empty}>{emptyLabel}</div>}
      {events.map((ev) => (
        <div key={ev.id} className={`${styles.row} ${styles[`tone_${ev.tone}`] ?? ''}`} data-kind={ev.kind}>
          <span className={styles.marker}>{marker(ev)}</span>
          <span className={styles.body}>
            <span className={styles.title}>{ev.title}</span>
            {ev.detail && <span className={styles.detail}>{ev.detail}</span>}
          </span>
          <Outcome outcome={ev.outcome} />
        </div>
      ))}
      {live && (
        <div className={styles.working}>
          <span className={styles.cursor}>▋</span> working…
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
