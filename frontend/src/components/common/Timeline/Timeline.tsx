import type { ReactNode } from 'react'
import type { Tone } from '@/constants/status'
import { cn } from '@/lib/utils'

export interface TimelineItemData {
  id: string
  tone?: Tone
  /** Custom node icon; falls back to a toned dot. */
  marker?: ReactNode
  title: ReactNode
  meta?: ReactNode
  body?: ReactNode
  active?: boolean
  onClick?: () => void
}

export interface TimelineProps {
  items: TimelineItemData[]
  /** Show a pulsing marker on the active item (live executions). */
  live?: boolean
}

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  accent: 'bg-primary',
  neutral: 'bg-fg-subtle',
}

export function Timeline({ items, live = false }: TimelineProps) {
  return (
    <ol className="m-0 list-none p-0">
      {items.map((item, i) => (
        <li
          key={item.id}
          className={cn(
            'flex gap-3 rounded-md px-2 py-0.5',
            item.active && 'bg-primary/10',
            item.onClick && 'cursor-pointer hover:bg-surface-2',
          )}
          onClick={item.onClick}
        >
          <div className="flex w-4 flex-shrink-0 flex-col items-center">
            <span
              className={cn(
                'mt-[3px] flex h-[14px] w-[14px] flex-shrink-0 items-center justify-center rounded-full border-2 border-card text-white',
                TONE_CLASS[item.tone ?? 'neutral'],
                live && item.active && 'animate-pulse',
              )}
            >
              {item.marker}
            </span>
            {i < items.length - 1 && (
              <span className="my-[2px] w-[2px] min-h-[12px] flex-1 bg-line" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-medium text-fg">{item.title}</span>
              {item.meta && <span className="flex-shrink-0 text-[11px] text-fg-subtle">{item.meta}</span>}
            </div>
            {item.body && <div className="mt-1 text-xs text-fg-muted">{item.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
