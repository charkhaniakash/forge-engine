import { Icon } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { RISK_LEVEL, resolveStatus } from '@/constants/status'
import type { PlanStep } from '@/types'
import { cn } from '@/lib/utils'

const TYPE_ICON = {
  edit: 'file',
  test: 'check',
  verify: 'check',
  manual: 'alert',
} as const

// StatusMeta.tone → text color for the risk badge
const TONE_TEXT: Record<string, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
  accent: 'text-primary',
  neutral: 'text-fg-subtle',
}

export interface PlanStepCardProps {
  step: PlanStep
  index: number
}

export function PlanStepCard({ step, index }: PlanStepCardProps) {
  const risk = resolveStatus(RISK_LEVEL, step.estimated_risk)
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-background/40 p-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs font-semibold text-fg-muted">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-[13px] font-medium text-fg">{step.title}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="gap-1 font-normal">
              <Icon name={TYPE_ICON[step.type] ?? 'file'} size={11} /> {step.type}
            </Badge>
            <Badge variant="outline" className={cn('font-normal', TONE_TEXT[risk.tone] ?? 'text-fg-subtle')}>
              {risk.label} risk
            </Badge>
            {step.user_edited && (
              <Badge variant="outline" className="border-primary/30 font-normal text-primary">
                edited
              </Badge>
            )}
          </div>
        </div>
        {step.description && <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{step.description}</p>}
        {step.affected_files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {step.affected_files.map((f) => (
              <span key={f} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                <Icon name="file" size={11} /> {f}
              </span>
            ))}
          </div>
        )}
        {step.depends_on.length > 0 && (
          <div className="mt-2 font-mono text-[11px] text-fg-subtle">
            Depends on: {step.depends_on.join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}
