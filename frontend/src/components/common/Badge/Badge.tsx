import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { Tone } from '@/constants/status'

export interface BadgeProps {
  tone?: Tone
  /** Show a leading status dot. */
  dot?: boolean
  size?: 'sm' | 'md'
  children: ReactNode
}

const toneClasses: Record<Tone, string> = {
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  danger: 'text-destructive bg-destructive/10',
  info: 'text-info bg-info/10',
  neutral: 'text-fg-muted bg-[var(--neutral-subtle)]',
  accent: 'text-primary bg-primary/10',
}

const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'text-[11px] px-2 py-[2px]',
  md: 'text-[12px] px-3 py-[3px]',
}

export function Badge({ tone = 'neutral', dot = false, size = 'md', children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap border border-transparent leading-none',
        toneClasses[tone],
        sizeClasses[size],
      )}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />}
      {children}
    </span>
  )
}
