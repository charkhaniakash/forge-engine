import type { ActivityEvent } from './model'
import { activityMarker } from './normalize'
import styles from './ActivityRow.module.css'

function Outcome({ outcome }: { outcome: ActivityEvent['outcome'] }) {
  if (!outcome) return null
  if (outcome === 'running') return <span className={styles.spinner} aria-label="running" />
  if (outcome === 'ok') return <span className={`${styles.outcome} ${styles.ok}`}>✓</span>
  return <span className={`${styles.outcome} ${styles.fail}`}>✗</span>
}

/** One line of agent activity — a milestone message or one line inside a work group. Shared across the Mission thread. */
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
