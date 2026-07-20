import { CompactStep } from './ActivityRow'
import { formatDuration } from './normalize'
import type { WorkGroup } from './model'
import styles from './ThoughtGroup.module.css'

export interface ThoughtGroupProps {
  group: WorkGroup
  /** Open by default and left open — this is the currently-streaming block. */
  isLive: boolean
}

/** A burst of consecutive reasoning/tool-use events shown inline as Devin-style steps. */
export function ThoughtGroup({ group, isLive }: ThoughtGroupProps) {
  const verb = group.hasToolActivity ? 'Worked' : 'Thought'
  const duration = group.durationMs != null ? formatDuration(group.durationMs) : null
  const label = duration ? `${verb} for ${duration}` : verb

  return (
    <div className={`${styles.group} ${isLive ? styles.live : ''}`}>
      <div className={styles.header}>
        <span className={styles.badge}>
          {isLive ? (
            <span className={styles.liveSpinner}>
              <span className={styles.spinner} />
            </span>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={styles.checkIcon}>
              <circle cx="8" cy="8" r="7" stroke="var(--success)" strokeWidth="1.5" fill="none" />
              <path d="M5 8.5l2 2 4-4" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
