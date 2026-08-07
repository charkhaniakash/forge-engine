import type { ActivityEvent } from './model'
import { activityMarker } from './normalize'
import { cn } from '@/lib/utils'

// event tone → marker/title accent color
const TONE_TEXT: Record<string, string> = {
  success: 'text-success',
  ok: 'text-success',
  error: 'text-destructive',
  danger: 'text-destructive',
  warn: 'text-warning',
  warning: 'text-warning',
  info: 'text-info',
  accent: 'text-primary',
  muted: 'text-fg-subtle',
  neutral: 'text-fg-muted',
  default: 'text-fg-muted',
}

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <span
      aria-label="running"
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-fg-subtle"
      style={{ width: size, height: size }}
    />
  )
}

function Outcome({ outcome }: { outcome: ActivityEvent['outcome'] }) {
  if (!outcome) return null
  if (outcome === 'running') return <Spinner size={12} />
  if (outcome === 'ok') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-success">
        <path d="M4 8.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-warning">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M8 5v4M8 11v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** One line of agent activity — calm, clear, never alarmist. */
export function ActivityRow({ ev }: { ev: ActivityEvent }) {
  return (
    <div className="flex items-start gap-2 py-0.5" data-kind={ev.kind}>
      <span className={cn('mt-px flex-shrink-0 font-mono text-xs', TONE_TEXT[ev.tone] ?? 'text-fg-subtle')}>
        {activityMarker(ev)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-[13px] text-fg">{ev.title}</span>
        {ev.detail && <span className="ml-1.5 font-mono text-xs text-fg-subtle">{ev.detail}</span>}
      </span>
      <Outcome outcome={ev.outcome} />
    </div>
  )
}

/** Compact step — minimal, clean, used inside ThoughtGroup. */
export function CompactStep({ ev }: { ev: ActivityEvent }) {
  return (
    <div className="flex items-start gap-2 py-1" data-kind={ev.kind}>
      <span className="mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        {ev.outcome === 'running' ? (
          <Spinner size={10} />
        ) : ev.outcome === 'ok' ? (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" className="text-success">
            <path d="M4 8.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span className="font-mono text-[10px] text-fg-subtle">{activityMarker(ev)}</span>
        )}
      </span>
      <span className="min-w-0 flex-1 leading-relaxed">
        <span className="text-[13px] text-fg-muted">{ev.title}</span>
        {ev.detail && <span className="ml-1.5 break-all font-mono text-[11px] text-fg-subtle">{ev.detail}</span>}
      </span>
    </div>
  )
}
