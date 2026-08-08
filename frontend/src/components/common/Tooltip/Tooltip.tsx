import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TooltipProps {
  content: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}

const SIDE_CLASSES: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  bottom: 'top-[calc(100%+6px)] left-1/2 -translate-x-1/2',
  left: 'right-[calc(100%+6px)] top-1/2 -translate-y-1/2',
  right: 'left-[calc(100%+6px)] top-1/2 -translate-y-1/2',
}

/** Lightweight CSS-positioned tooltip. Wraps a single focusable/hoverable child. */
export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  if (!content) return <>{children}</>
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-[500] whitespace-nowrap rounded-md border border-line bg-surface-3 px-2 py-1 text-xs text-fg shadow-lg [animation:forge-fade-in_120ms_var(--ease)]',
            SIDE_CLASSES[side],
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
