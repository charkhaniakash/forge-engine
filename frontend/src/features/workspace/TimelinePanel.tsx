import { useAppSelector } from '@/app/hooks'
import styles from './workspace.module.css'

function dotClass(status: string): string {
  if (status === 'success' || status === 'completed' || status === 'passed') return styles.dotSuccess
  if (status === 'failed' || status === 'error') return styles.dotFailed
  if (status === 'running' || status === 'pending') return styles.dotRunning
  return styles.dotNeutral
}

export function TimelinePanel() {
  const timeline = useAppSelector((s) => s.workspaceActivity.timeline)

  if (timeline.length === 0) {
    return <div className={styles.empty}>No activity yet. Timeline events appear here as the agent works.</div>
  }

  return (
    <div>
      {timeline.map((e) => (
        <div key={e.id} className={styles.timelineItem}>
          <span className={`${styles.timelineDot} ${dotClass(e.status)}`} />
          <div className={styles.timelineMain}>
            <div className={styles.timelineTitle}>
              {e.phase}{e.step && e.step !== e.phase ? ` · ${e.step}` : ''}
            </div>
            {e.detail && <div className={styles.timelineMeta}>{e.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
