import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import styles from './workspace.module.css'

interface ActivityEvent {
  id: string
  type: 'planning' | 'reading' | 'creating' | 'updating' | 'running' | 'success' | 'error'
  label: string
  timestamp: number
  details?: string
}

function activityIcon(type: string): string {
  const icons: Record<string, string> = {
    planning: 'thinking',
    reading: 'fileText',
    creating: 'plus',
    updating: 'edit',
    running: 'play',
    success: 'checkCircle',
    error: 'alertCircle',
  }
  return icons[type] || 'circle'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function AIActivityPanel() {
  const events = useAppSelector((s) => s.workspaceActivity?.aiEvents || [])
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [events.length])

  if (!events || events.length === 0) {
    return (
      <div className={styles.activityPanelEmpty}>
        <Icon name="inbox" size={24} />
        <p>Waiting for activity...</p>
        <span>Live operations will appear here</span>
      </div>
    )
  }

  return (
    <div className={styles.activityPanel}>
      <div className={styles.activityList}>
        {events.slice(-50).map((e, idx) => {
          const isLatest = idx === events.slice(-50).length - 1
          return (
            <div
              key={e.id}
              className={`${styles.activityRow} ${isLatest ? styles.activityRowActive : ''}`}
            >
              <div className={styles.activityIcon}>
                <Icon name={activityIcon(e.type)} size={16} />
              </div>
              <div className={styles.activityContent}>
                <div className={styles.activityLabel}>{e.label}</div>
                {e.details && <div className={styles.activityDetails}>{e.details}</div>}
              </div>
              <div className={styles.activityTime}>{fmtTime(e.timestamp)}</div>
            </div>
          )
        })}
      </div>
      <div ref={endRef} />
    </div>
  )
}
