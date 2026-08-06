import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import type { AIActivityEvent } from '@/types/workspaceEditor'
import styles from './workspace.module.css'

const NO_EVENTS: AIActivityEvent[] = []

type IconName = 'tool' | 'file' | 'plus' | 'build' | 'play' | 'check' | 'alert' | 'chat' | 'code' | 'git' | 'sparkles'

function activityIcon(type: string): IconName {
  if (type === 'reasoning' || type === 'repair_reasoning') return 'chat'
  if (type.includes('tool_call')) return 'tool'
  if (type.includes('tool_result')) return 'check'
  if (type.includes('repair_strategy')) return 'sparkles'
  if (type.includes('repair_attempt')) return 'build'
  if (type.includes('validation')) return 'check'
  if (type.includes('publishing')) return 'git'
  if (type.includes('deviation')) return 'alert'
  if (type.includes('creat')) return 'plus'
  if (type.includes('read') || type.includes('file')) return 'file'
  if (type.includes('build') || type.includes('compil')) return 'build'
  if (type.includes('error')) return 'alert'
  if (type.includes('success') || type.includes('complete')) return 'check'
  return 'sparkles'
}

function activityIconColor(type: string): string {
  if (type === 'reasoning' || type === 'repair_reasoning') return 'var(--text-tertiary)'
  if (type.includes('tool_result') || type.includes('success') || type.includes('complete') || type.includes('check')) return 'var(--success)'
  if (type.includes('error') || type.includes('fail') || type.includes('deviation')) return 'var(--danger)'
  if (type.includes('validation')) return 'var(--warning)'
  if (type.includes('publishing') || type.includes('git')) return 'var(--accent)'
  if (type.includes('repair')) return 'var(--danger)'
  if (type.includes('tool_call')) return 'var(--info)'
  return 'var(--text-tertiary)'
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
        <Icon name="sparkles" size={20} />
        <p>No activity yet</p>
        <span>AI operations will stream in here as the agent works</span>
      </div>
    )
  }

  const visible = events.slice(-60)

  return (
    <div className={styles.activityPanel}>
      <div className={styles.activityList}>
        {visible.map((e: AIActivityEvent, idx: number) => {
          const isLatest = idx === visible.length - 1
          const icon = activityIcon(e.type)
          const iconColor = activityIconColor(e.type)
          return (
            <div
              key={e.id}
              className={`${styles.activityRow} ${isLatest ? styles.activityRowActive : ''}`}
            >
              <div className={styles.activityIcon} style={{ color: iconColor }}>
                <Icon name={icon} size={13} />
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
        <div ref={endRef} />
      </div>
    </div>
  )
}
