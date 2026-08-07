import { Icon } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import type { RepairAttemptVM } from './model'
import { cn } from '@/lib/utils'

export interface RepairAttemptCardProps {
  attempt: RepairAttemptVM
}

/** Human-centered labels for repair outcomes — no "failed". */
const OUTCOME_LABEL: Record<string, string> = {
  passed: 'Resolved',
  improved: 'Partially resolved',
  no_change: 'No change',
  regressed: 'Introduced new issue',
  cannot_repair: 'Needs developer attention',
}

const OUTCOME_STYLE: Record<string, { border: string; chip: string }> = {
  passed:        { border: 'border-l-success',     chip: 'bg-success/10 text-success' },
  improved:      { border: 'border-l-warning',     chip: 'bg-warning/10 text-warning' },
  no_change:     { border: 'border-l-border',      chip: 'bg-muted text-fg-subtle' },
  regressed:     { border: 'border-l-destructive', chip: 'bg-destructive/10 text-destructive' },
  cannot_repair: { border: 'border-l-destructive', chip: 'bg-destructive/10 text-destructive' },
}

export function RepairAttemptCard({ attempt }: RepairAttemptCardProps) {
  const label = attempt.outcome ? OUTCOME_LABEL[attempt.outcome] ?? '' : ''
  const style = attempt.outcome ? OUTCOME_STYLE[attempt.outcome] : undefined
  const pct = attempt.confidence != null ? Math.round(attempt.confidence * 100) : null

  return (
    <div className={cn('rounded-r-lg border-l-2 bg-card p-3', style?.border ?? 'border-l-border')} data-outcome={attempt.outcome}>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-muted text-fg-subtle">
          <Icon name="tool" size={12} />
        </span>
        <span className="text-[13px] font-medium text-fg">Attempt {attempt.attempt}</span>
        {label && (
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', style?.chip ?? 'bg-muted text-fg-subtle')}>
            {label}
          </span>
        )}
      </div>

      {attempt.rootCause && <p className="mt-2 text-xs leading-relaxed text-fg-muted">{attempt.rootCause}</p>}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {attempt.strategy && (
          <Badge variant="secondary" className="font-normal">
            {attempt.strategy === 'targeted_fix' ? 'Targeted fix' : attempt.strategy}
          </Badge>
        )}
        {pct != null && <Badge variant="secondary" className="font-normal">{pct}% confident</Badge>}
        {(attempt.errorsBefore != null || attempt.errorsAfter != null) && (
          <Badge variant="secondary" className="font-mono font-normal">
            {attempt.errorsBefore ?? '—'} → {attempt.errorsAfter ?? '—'} issues
          </Badge>
        )}
      </div>

      {attempt.filesModified.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attempt.filesModified.map((f) => (
            <span key={f} className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
              <Icon name="file" size={10} /> {f}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
