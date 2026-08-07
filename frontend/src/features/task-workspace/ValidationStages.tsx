import { useState } from 'react'
import { Icon } from '@/components/common'
import { Separator } from '@/components/ui/separator'
import type { ValidationStageVM } from './model'
import { cn } from '@/lib/utils'

export interface ValidationStagesProps {
  stages: ValidationStageVM[]
  title?: string
}

/** Human-readable outcome labels — never says "Failed" */
const OUTCOME_META: Record<string, { icon: 'check' | 'x' | 'clock' | 'dot' | 'alert'; cls: string; label: string }> = {
  passed:               { icon: 'check', cls: 'ok',       label: 'Passed' },
  failed:               { icon: 'x',     cls: 'issues',   label: 'Found issues' },
  no_tests:             { icon: 'dot',   cls: 'info',     label: 'No tests' },
  infrastructure_error: { icon: 'alert', cls: 'warning',  label: 'Infra issue' },
}

// badge class key → text + background colors
const CLS_COLOR: Record<string, { text: string; bg: string }> = {
  ok:      { text: 'text-success',     bg: 'bg-success/10' },
  issues:  { text: 'text-destructive', bg: 'bg-destructive/10' },
  info:    { text: 'text-info',        bg: 'bg-info/10' },
  warning: { text: 'text-warning',     bg: 'bg-warning/10' },
  active:  { text: 'text-primary',     bg: 'bg-primary/10' },
  neutral: { text: 'text-fg-subtle',   bg: 'bg-muted' },
}

function stageBadge(stage: ValidationStageVM): { icon: 'check' | 'x' | 'clock' | 'dot' | 'alert'; cls: string; label: string } {
  if (stage.outcome && OUTCOME_META[stage.outcome]) {
    return OUTCOME_META[stage.outcome]
  }
  if (stage.state === 'skipped' && stage.reason?.startsWith('misconfigured:')) {
    return { icon: 'alert', cls: 'warning', label: 'Misconfigured' }
  }
  if (stage.state === 'skipped') {
    return { icon: 'dot', cls: 'neutral', label: 'Skipped' }
  }
  switch (stage.state) {
    case 'passed':
      return { icon: 'check', cls: 'ok', label: 'Passed' }
    case 'failed':
      return { icon: 'x', cls: 'issues', label: 'Found issues' }
    case 'active':
      return { icon: 'clock', cls: 'active', label: 'Running' }
    case 'pending':
      return { icon: 'dot', cls: 'neutral', label: 'Pending' }
    default:
      return { icon: 'dot', cls: 'neutral', label: '' }
  }
}

function displayReason(reason: string): string {
  const prefixes = ['misconfigured: ', 'skipped: ']
  for (const p of prefixes) {
    if (reason.startsWith(p)) return reason.slice(p.length)
  }
  return reason
}

function fmtDuration(ms?: number): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
}

/** Summary row — total stages, how many passed, how many have issues. */
function StageSummary({ stages }: { stages: ValidationStageVM[] }) {
  const total = stages.length
  const passed = stages.filter((s) => s.state === 'passed').length
  const issues = stages.filter((s) => s.state === 'failed').length
  const skipped = stages.filter((s) => s.state === 'skipped').length
  const running = stages.filter((s) => s.state === 'active').length

  const Stat = ({ count, label, color }: { count: React.ReactNode; label: string; color?: string }) => (
    <div className="flex items-center gap-1.5">
      <span className={cn('font-mono text-sm font-semibold tabular-nums', color)}>{count}</span>
      <span className="text-xs text-fg-subtle">{label}</span>
    </div>
  )

  return (
    <div className="flex items-center gap-3 py-1">
      <Stat count={total} label={`check${total === 1 ? '' : 's'}`} />
      <Separator orientation="vertical" className="h-3.5" />
      <Stat count={passed} label="passed" color="text-success" />
      {issues > 0 && (
        <>
          <Separator orientation="vertical" className="h-3.5" />
          <Stat count={issues} label="with feedback" color="text-warning" />
        </>
      )}
      {running > 0 && (
        <>
          <Separator orientation="vertical" className="h-3.5" />
          <Stat count={<span className="text-primary"><Spinner /></span>} label={`${running} running`} />
        </>
      )}
      {skipped > 0 && (
        <>
          <Separator orientation="vertical" className="h-3.5" />
          <Stat count={skipped} label="skipped" color="text-fg-subtle" />
        </>
      )}
    </div>
  )
}

export function ValidationStages({ stages, title: _title = '' }: ValidationStagesProps) {
  const [open, setOpen] = useState<string | null>(() => {
    const running = stages.find((s) => s.state === 'active')
    const issues = stages.find((s) => s.state === 'failed')
    return (running ?? issues)?.name ?? null
  })

  const issueCount = stages.filter((s) => s.state === 'failed').length
  const totalCount = stages.length

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] font-medium text-fg">
        {issueCount > 0
          ? `Build found ${issueCount} issue${issueCount === 1 ? '' : 's'} across ${totalCount} check${totalCount === 1 ? '' : 's'}`
          : `All ${totalCount} check${totalCount === 1 ? '' : 's'} passed`}
      </p>

      <StageSummary stages={stages} />

      <div className="flex flex-col gap-px">
        {stages.map((stage) => {
          const badge = stageBadge(stage)
          const color = CLS_COLOR[badge.cls] ?? CLS_COLOR.neutral
          const expanded = open === stage.name
          const showReason =
            (stage.state === 'skipped' || stage.outcome === 'no_tests' || stage.outcome === 'infrastructure_error') &&
            stage.reason

          return (
            <div key={stage.name} data-state={stage.state}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                onClick={() => setOpen(expanded ? null : stage.name)}
              >
                <span className={cn('flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full', color.bg, color.text)}>
                  {stage.state === 'active' ? <Spinner /> : <Icon name={badge.icon} size={11} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{stage.name}</span>
                <span className={cn('flex-shrink-0 text-xs', color.text)}>{badge.label}</span>
                {stage.exitCode != null && stage.exitCode !== 0 && (
                  <span className="flex-shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-fg-subtle">exit {stage.exitCode}</span>
                )}
                <span className="flex-shrink-0 font-mono text-[11px] text-fg-subtle">{fmtDuration(stage.durationMs)}</span>
                {stage.log.length > 0 && (
                  <Icon
                    name="chevronRight"
                    size={12}
                    className={cn('flex-shrink-0 text-fg-subtle transition-transform duration-150', expanded && 'rotate-90')}
                  />
                )}
              </button>

              {showReason && (
                <div className="ml-9 pb-1 text-xs text-fg-subtle">{displayReason(stage.reason!)}</div>
              )}

              {expanded && stage.log.length > 0 && (
                <div className="ml-9 mt-1 overflow-hidden rounded-md border border-border bg-inset">
                  <div className="flex items-center justify-between border-b border-border px-2.5 py-1">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-fg-subtle">Output</span>
                    <span className="font-mono text-[10px] text-fg-subtle">{stage.log.length} lines</span>
                  </div>
                  <pre className="max-h-72 overflow-auto p-2.5 font-mono text-[11px] leading-relaxed text-fg-muted">
                    {stage.log.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
