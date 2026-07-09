import type { ReactNode } from 'react'
import { LifecycleTimeline } from './LifecycleTimeline'
import { ActivityFeed } from './ActivityFeed'
import type { ActivityEvent, LifecyclePhase } from './model'
import styles from './MissionView.module.css'

export interface MissionViewProps {
  header: ReactNode
  phases: LifecyclePhase[]
  activePhaseKey?: string
  onSelectPhase?: (phase: LifecyclePhase) => void
  /** Left column, lower half: the agent's live thinking (reasoning + milestones). */
  reasoning: ActivityEvent[]
  /** Right column: tool calls / results / validation activity. */
  tools: ActivityEvent[]
  /** Right column footer: derived metric chips (all from real data). */
  metrics?: ReactNode
  /** Center column: the evolving phase detail. */
  detail: ReactNode
  live: boolean
}

/**
 * The Mission workspace — one evolving page for the whole autonomous run.
 *  top    · mission status
 *  left   · lifecycle timeline + live reasoning
 *  center · plan → execution → validation → repair → diffs
 *  right  · tool activity + metrics
 * Every pane is fed exclusively by backend events; nothing here is simulated.
 */
export function MissionView({
  header,
  phases,
  activePhaseKey,
  onSelectPhase,
  reasoning,
  tools,
  metrics,
  detail,
  live,
}: MissionViewProps) {
  return (
    <div className={styles.mission}>
      <div className={styles.top}>{header}</div>

      <div className={styles.body}>
        <aside className={styles.left}>
          <section className={styles.leftTop}>
            <div className={styles.paneTitle}>Lifecycle</div>
            <LifecycleTimeline phases={phases} activeKey={activePhaseKey} onSelect={onSelectPhase} />
          </section>
          <section className={styles.leftBottom}>
            <div className={styles.paneTitle}>
              Reasoning
              {live && <span className={styles.livePip} />}
            </div>
            <div className={styles.feedWrap}>
              <ActivityFeed events={reasoning} live={live} emptyLabel="No reasoning streamed yet." />
            </div>
          </section>
        </aside>

        <main className={styles.center}>{detail}</main>

        <aside className={styles.right}>
          <div className={styles.paneTitle}>Tool activity</div>
          <div className={styles.feedWrap}>
            <ActivityFeed events={tools} live={live} emptyLabel="No tool activity yet." />
          </div>
          {metrics && <div className={styles.metrics}>{metrics}</div>}
        </aside>
      </div>
    </div>
  )
}
