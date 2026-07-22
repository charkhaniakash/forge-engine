import { CompactStep } from './ActivityRow'
import { formatDuration } from './normalize'
import type { WorkGroup } from './model'
import styles from './ThoughtGroup.module.css'

export interface ThoughtGroupProps {
  group: WorkGroup
  isLive: boolean
}

/** A burst of consecutive reasoning/tool-use events shown inline as steps. */
export function ThoughtGroup({ group, isLive }: ThoughtGroupProps) {
  const verb = group.hasToolActivity ? 'Working' : 'Exploring'
  const duration = group.durationMs != null ? formatDuration(group.durationMs) : null
  const label = duration
    ? `${verb} · ${duration}`
    : verb

  return (
    <div className={`${styles.group} ${isLive ? styles.live : ''}`}>
      <div className={styles.header}>
        <span className={styles.badge}>
          {isLive ? (
            <span className={styles.spinnerDot} />
          ) : (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className={styles.checkIcon}>
              <path d="M4 8.5l3 3 5-5" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className={styles.label}>{label}</span>
      </div>
      <div className={styles.steps}>
        {group.events.map((ev) => <CompactStep key={ev.id} ev={ev} />)}
      </div>
    </div>
  )
}
