import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import type { AIActivityEvent } from '@/types/workspaceEditor'
import { cn } from '@/lib/utils'

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
  if (type === 'reasoning' || type === 'repair_reasoning') return 'text-fg-subtle'
  if (type.includes('tool_result') || type.includes('success') || type.includes('complete') || type.includes('check')) return 'text-success'
  if (type.includes('error') || type.includes('fail') || type.includes('deviation')) return 'text-destructive'
  if (type.includes('validation')) return 'text-warning'
  if (type.includes('publishing') || type.includes('git')) return 'text-primary'
  if (type.includes('repair')) return 'text-destructive'
  if (type.includes('tool_call')) return 'text-info'
  return 'text-fg-subtle'
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
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-fg-subtle">
        <Icon name="sparkles" size={20} />
        <p className="text-[13px] font-medium text-fg-muted">No activity yet</p>
        <span className="text-xs">AI operations will stream in here as the agent works</span>
      </div>
    )
  }

  const visible = events.slice(-60)

  return (
    <div className="flex flex-col p-2">
      {visible.map((e: AIActivityEvent, idx: number) => {
        const isLatest = idx === visible.length - 1
        return (
          <div
            key={e.id}
            className={cn('flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors', isLatest ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
          >
            <div className={cn('mt-0.5 flex-shrink-0', activityIconColor(e.type))}>
              <Icon name={activityIcon(e.type)} size={13} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-fg">{e.label}</div>
              {e.tool && <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">{e.tool}</div>}
            </div>
            <div className="flex-shrink-0 font-mono text-[10px] text-fg-subtle">{fmtTime(e.ts)}</div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
