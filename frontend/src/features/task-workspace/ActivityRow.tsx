import type { ActivityEvent } from './model'
import { activityMarker } from './normalize'
import styles from './ActivityRow.module.css'

function Outcome({ outcome }: { outcome: ActivityEvent['outcome'] }) {
  if (!outcome) return null
  if (outcome === 'running') return (
    <span className={styles.spinnerWrap}>
      <span className={styles.spinner} aria-label="running" />
    </span>
  )
  if (outcome === 'ok') return <span className={`${styles.outcome} ${styles.ok}`}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M5 8.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
  return <span className={`${styles.outcome} ${styles.fail}`}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
}

/** One line of agent activity — a milestone message or one line inside a work group. Devin-style: icon + description + status. */
export function ActivityRow({ ev }: { ev: ActivityEvent }) {
  return (
    <div className={`${styles.row} ${styles[`tone_${ev.tone}`] ?? ''}`} data-kind={ev.kind}>
      <span className={styles.marker}>{activityMarker(ev)}</span>
      <span className={styles.body}>
        <span className={styles.title}>{ev.title}</span>
        {ev.detail && <span className={styles.detail}>{ev.detail}</span>}
      </span>
      <Outcome outcome={ev.outcome} />
    </div>
  )
}

/** Compact Devin-style step: a single rendered step used directly in the timeline (not inside a ThoughtGroup). */
export function CompactStep({ ev }: { ev: ActivityEvent }) {
  return (
    <div className={styles.compactRow} data-kind={ev.kind}>
      <span className={styles.compactIcon}>
        {ev.outcome === 'running' ? (
          <span className={styles.spinner} aria-label="running" />
        ) : ev.outcome === 'ok' ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="var(--success)" strokeWidth="1.5" fill="none" />
            <path d="M5 8.5l2 2 4-4" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : ev.outcome === 'fail' ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" stroke="var(--danger)" strokeWidth="1.5" fill="none" />
            <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ) : (
          <span className={styles.markerCompact}>{activityMarker(ev)}</span>
        )}
      </span>
      <span className={styles.compactBody}>
        <span className={styles.compactTitle}>{ev.title}</span>
        {ev.detail && <span className={styles.compactDetail}>{ev.detail}</span>}
      </span>
    </div>
  )
}
