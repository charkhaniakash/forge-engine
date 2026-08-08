import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean
  interactive?: boolean
}

export function Card({
  padded = true,
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      data-padded={padded}
      className={cn(
        'group/card bg-card border border-line rounded-lg overflow-hidden',
        padded && 'p-5',
        interactive &&
          'cursor-pointer transition-colors duration-150 hover:border-line-strong hover:bg-surface-2',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4 group-data-[padded=false]/card:mb-0 group-data-[padded=false]/card:px-5 group-data-[padded=false]/card:py-4 group-data-[padded=false]/card:border-b group-data-[padded=false]/card:border-line-subtle">
      <div className="min-w-0">
        <div className="font-semibold text-[16px] text-fg">{title}</div>
        {subtitle && <div className="text-[13px] text-fg-muted mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
