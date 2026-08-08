import type { Tone } from '@/constants/status'
import { cn } from '@/lib/utils'

export interface ProgressBarProps {
  /** 0–1 fraction. Omit for an indeterminate bar. */
  value?: number
  tone?: Tone
  height?: number
  label?: string
}

const toneClasses: Record<Tone, string> = {
  accent: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  neutral: 'bg-[var(--neutral)]',
}

export function ProgressBar({ value, tone = 'accent', height = 6, label }: ProgressBarProps) {
  const indeterminate = value == null
  const pct = Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)
  return (
    <div className="w-full">
      {label && (
        <div className="flex justify-between text-[12px] text-fg-muted mb-1">
          <span>{label}</span>
          {!indeterminate && <span>{pct}%</span>}
        </div>
      )}
      <div
        className="bg-surface-2 rounded-full overflow-hidden w-full"
        style={{ height }}
        role="progressbar"
        aria-valuenow={pct}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-200',
            toneClasses[tone],
            indeterminate && 'w-[40%] animate-[forge-indeterminate_1.2s_ease_infinite]',
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
