import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'
import styles from './workspace.module.css'

/** Emoji glyph for an ai_activity event type. */
function glyph(type: string): string {
  if (type.includes('reasoning')) return '💭'
  if (type.includes('tool_call')) return '🔧'
  if (type.includes('tool_result')) return '✅'
  if (type.includes('read')) return '📖'
  if (type.includes('write')) return '✏️'
  if (type.includes('search')) return '🔍'
  if (type.includes('deviation')) return '⚠️'
  return '•'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function AIActivityFeed() {
  const events = useAppSelector((s) => s.workspaceActivity.aiEvents)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  if (events.length === 0) {
    return <div className={styles.empty}>Waiting for the agent… live reasoning and tool calls appear here.</div>
  }

  return (
    <div className={styles.aiFeed}>
      {events.map((e) => (
        <div key={e.id} className={styles.aiRow}>
          <span className={styles.aiIcon}>{glyph(e.type)}</span>
          <span className={styles.aiLabel}>{e.label}</span>
          <span className={styles.aiTime}>{fmtTime(e.ts)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
