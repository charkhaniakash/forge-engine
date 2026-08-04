import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import type { AIActivityEvent } from '@/types/workspaceEditor'
import styles from './workspace.module.css'

// Stable empty array — `?? []` inside a selector creates a new reference every
// render, forcing re-renders on every store dispatch even when idle.
const NO_EVENTS: AIActivityEvent[] = []

function activityIconName(type: string): 'tool' | 'file' | 'plus' | 'build' | 'play' | 'check' | 'alert' {
  if (type.includes('tool_call') || type.includes('tool')) return 'tool'
  if (type.includes('read'))    return 'file'
  if (type.includes('creat'))   return 'plus'
  if (type.includes('build'))   return 'build'
  if (type.includes('success')) return 'check'
  if (type.includes('error'))   return 'alert'
  return 'play'
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function AIActivityPanel() {
  const events = useAppSelector((s) => s.workspaceActivity?.aiEvents ?? NO_EVENTS)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className={styles.activityPanelEmpty}>
        <Icon name="sparkles" size={24} />
        <p>Waiting for activity...</p>
        <span>Live operations will appear here</span>
      </div>
    )
  }

  return (
    <div className={styles.activityPanel}>
      <div className={styles.activityList}>
        {events.slice(-50).map((e: AIActivityEvent, idx: number) => {
          const isLatest = idx === Math.min(events.length, 50) - 1
          return (
            <div
              key={e.id}
              className={`${styles.activityRow} ${isLatest ? styles.activityRowActive : ''}`}
            >
              <div className={styles.activityIcon}>
                <Icon name={activityIconName(e.type)} size={16} />
              </div>
              <div className={styles.activityContent}>
                <div className={styles.activityLabel}>{e.label}</div>
                {e.tool && (
                  <div className={styles.activityDetails}>{e.tool}</div>
                )}
              </div>
              <div className={styles.activityTime}>{fmtTime(e.ts)}</div>
            </div>
          )
        })}
      </div>
      <div ref={endRef} />
    </div>
  )
}
