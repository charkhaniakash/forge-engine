import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/app/hooks'

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
    return (
      <div className="p-4 text-xs text-fg-subtle">
        Waiting for the agent… live reasoning and tool calls appear here.
      </div>
    )
  }

  return (
    <div className="flex flex-col p-2">
      {events.map((e) => (
        <div key={e.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2">
          <span className="flex-shrink-0 text-sm leading-none">{glyph(e.type)}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{e.label}</span>
          <span className="flex-shrink-0 font-mono text-[10px] text-fg-subtle">{fmtTime(e.ts)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
