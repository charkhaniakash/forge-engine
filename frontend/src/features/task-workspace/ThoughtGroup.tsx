import { Accordion } from '@/components/common'
import { ActivityRow } from './ActivityRow'
import { formatDuration } from './normalize'
import type { WorkGroup } from './model'
import styles from './ThoughtGroup.module.css'

export interface ThoughtGroupProps {
  group: WorkGroup
  /** Open by default and left open — this is the currently-streaming block. */
  isLive: boolean
}

/** A burst of consecutive reasoning/tool-use events, collapsed behind one "Thought for Ns" / "Worked for Xm Ys" line. */
export function ThoughtGroup({ group, isLive }: ThoughtGroupProps) {
  const verb = group.hasToolActivity ? 'Worked' : 'Thought'
  const title = group.durationMs != null ? `${verb} for ${formatDuration(group.durationMs)}` : verb
  const subtitle = group.events.length > 1 ? `${group.events.length} steps` : undefined

  return (
    <Accordion className={styles.accordion} title={title} subtitle={subtitle} defaultOpen={isLive}>
      <div className={styles.rows}>
        {group.events.map((ev) => <ActivityRow key={ev.id} ev={ev} />)}
      </div>
    </Accordion>
  )
}
