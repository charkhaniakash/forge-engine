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
  if (outcome === 'ok') return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={styles.outcomeOk}>
      <path d="M4 8.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={styles.outcomeWarn}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M8 5v4M8 11v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** One line of agent activity — calm, clear, never alarmist */
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

/** Compact step — minimal, clean, used inside ThoughtGroup */
export function CompactStep({ ev }: { ev: ActivityEvent }) {
  return (
    <div className={styles.compactRow} data-kind={ev.kind}>
      <span className={styles.compactIcon}>
        {ev.outcome === 'running' ? (
          <span className={styles.spinnerSm} aria-label="running" />
        ) : ev.outcome === 'ok' ? (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className={styles.compactOk}>
            <path d="M4 8.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className={styles.compactMarker}>{activityMarker(ev)}</span>
        )}
      </span>
      <span className={styles.compactBody}>
        <span className={styles.compactTitle}>{ev.title}</span>
        {ev.detail && <span className={styles.compactDetail}>{ev.detail}</span>}
      </span>
    </div>
  )
}
