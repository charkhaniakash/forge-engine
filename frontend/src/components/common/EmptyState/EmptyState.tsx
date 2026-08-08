import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Compact variant for inline/panel use. */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center gap-2',
        compact ? 'py-8 px-4' : 'py-16 px-6',
      )}
    >
      {icon && <div className="text-fg-subtle mb-2 flex">{icon}</div>}
      <div className={cn('font-semibold text-fg', compact ? 'text-[14px]' : 'text-[16px]')}>
        {title}
      </div>
      {description && (
        <div className="text-fg-muted text-[13px] max-w-[420px]">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
