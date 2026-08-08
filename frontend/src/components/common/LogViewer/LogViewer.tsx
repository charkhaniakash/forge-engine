import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export interface LogLine {
  id?: string | number
  text: string
  tone?: 'default' | 'info' | 'success' | 'warning' | 'error' | 'muted'
}

export interface LogViewerProps {
  lines: LogLine[]
  /** Auto-scroll to the newest line as lines arrive. */
  follow?: boolean
  /** Show a blinking "live" cursor at the bottom. */
  live?: boolean
  maxHeight?: number
  emptyLabel?: string
}

const TONE: Record<NonNullable<LogLine['tone']>, string> = {
  default: 'text-fg',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  muted: 'text-fg-subtle',
}

/** Terminal-style streaming log surface. */
export function LogViewer({
  lines,
  follow = true,
  live = false,
  maxHeight = 220,
  emptyLabel = 'No output yet.',
}: LogViewerProps) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines.length, follow])

  return (
    <div
      className="overflow-y-auto rounded-md bg-inset p-3 font-mono text-xs leading-relaxed"
      style={{ maxHeight }}
    >
      {lines.length === 0 && !live && <div className="text-fg-subtle">{emptyLabel}</div>}
      {lines.map((line, i) => (
        <div
          key={line.id ?? i}
          className={cn('whitespace-pre-wrap break-words', TONE[line.tone ?? 'default'])}
        >
          {line.text}
        </div>
      ))}
      {live && <div className="text-primary animate-pulse">▋</div>}
      <div ref={endRef} />
    </div>
  )
}
