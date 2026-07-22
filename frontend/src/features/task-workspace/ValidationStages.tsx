import { useState } from 'react'
import { Icon } from '@/components/common'
import type { ValidationStageVM } from './model'
import styles from './ValidationStages.module.css'

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

/** Summary row at top — total stages, how many passed, how many have issues */
function StageSummary({ stages }: { stages: ValidationStageVM[] }) {
  const total = stages.length
  const passed = stages.filter((s) => s.state === 'passed').length
  const issues = stages.filter((s) => s.state === 'failed').length
  const skipped = stages.filter((s) => s.state === 'skipped').length
  const running = stages.filter((s) => s.state === 'active').length

  return (
    <div className={styles.summary}>
      <div className={styles.summaryStat}>
        <span className={styles.summaryCount}>{total}</span>
        <span className={styles.summaryLabel}>check{total === 1 ? '' : 's'}</span>
      </div>
      <div className={styles.summaryDivider} />
      <div className={styles.summaryStat}>
        <span className={styles.summaryCount} style={{ color: 'var(--success)' }}>{passed}</span>
        <span className={styles.summaryLabel}>passed</span>
      </div>
      {issues > 0 && (
        <>
          <div className={styles.summaryDivider} />
          <div className={styles.summaryStat}>
            <span className={styles.summaryCount} style={{ color: 'var(--warning)' }}>{issues}</span>
            <span className={styles.summaryLabel}>with feedback</span>
          </div>
        </>
      )}
      {running > 0 && (
        <>
          <div className={styles.summaryDivider} />
          <div className={styles.summaryStat}>
            <span className={styles.spinnerSm} />
            <span className={styles.summaryLabel}>{running} running</span>
          </div>
        </>
      )}
      {skipped > 0 && (
        <>
          <div className={styles.summaryDivider} />
          <div className={styles.summaryStat}>
            <span className={styles.summaryCount} style={{ color: 'var(--text-tertiary)' }}>{skipped}</span>
            <span className={styles.summaryLabel}>skipped</span>
          </div>
        </>
      )}
    </div>
  )
}

export function ValidationStages({ stages, title = '' }: ValidationStagesProps) {
  const [open, setOpen] = useState<string | null>(() => {
    const running = stages.find((s) => s.state === 'active')
    const issues = stages.find((s) => s.state === 'failed')
    return (running ?? issues)?.name ?? null
  })

  const issueCount = stages.filter((s) => s.state === 'failed').length
  const totalCount = stages.length

  return (
    <div className={styles.root}>
      <p className={styles.headline}>
        {issueCount > 0
          ? `Build found ${issueCount} issue${issueCount === 1 ? '' : 's'} across ${totalCount} check${totalCount === 1 ? '' : 's'}`
          : `All ${totalCount} check${totalCount === 1 ? '' : 's'} passed`}
      </p>

      <StageSummary stages={stages} />

      <div className={styles.stages}>
        {stages.map((stage) => {
          const badge = stageBadge(stage)
          const expanded = open === stage.name
          const showReason =
            (stage.state === 'skipped' || stage.outcome === 'no_tests' || stage.outcome === 'infrastructure_error') &&
            stage.reason

          return (
            <div key={stage.name} className={styles.stage} data-state={stage.state}>
              <button
                className={styles.stageHead}
                onClick={() => setOpen(expanded ? null : stage.name)}
              >
                <span className={`${styles.badge} ${styles[badge.cls]}`}>
                  {stage.state === 'active' ? (
                    <span className={styles.spinner} />
                  ) : (
                    <Icon name={badge.icon} size={11} />
                  )}
                </span>
                <span className={styles.stageName}>{stage.name}</span>
                <span className={`${styles.outcomeLabel} ${styles[badge.cls]}`}>{badge.label}</span>
                {stage.exitCode != null && stage.exitCode !== 0 && (
                  <span className={styles.exit}>exit {stage.exitCode}</span>
                )}
                <span className={styles.duration}>{fmtDuration(stage.durationMs)}</span>
                {stage.log.length > 0 && (
                  <Icon
                    name="chevronRight"
                    size={12}
                    className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
                  />
                )}
              </button>

              {showReason && (
                <div className={styles.reasonText}>
                  {displayReason(stage.reason!)}
                </div>
              )}

              {expanded && stage.log.length > 0 && (
                <>
                  <div className={styles.logToolbar}>
                    <span className={styles.logLabel}>Output</span>
                    <span className={styles.logCount}>{stage.log.length} lines</span>
                  </div>
                  <pre className={styles.log}>{stage.log.join('\n')}</pre>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
