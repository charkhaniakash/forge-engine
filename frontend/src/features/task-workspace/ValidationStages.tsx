import { useState } from 'react'
import { Icon } from '@/components/common'
import type { ValidationStageVM } from './model'
import styles from './ValidationStages.module.css'

export interface ValidationStagesProps {
  stages: ValidationStageVM[]
  /** Auto-expand the stage that is currently running or failed. */
  title?: string
}

const OUTCOME_META: Record<string, { icon: 'check' | 'x' | 'clock' | 'dot' | 'alert'; cls: string; label: string }> = {
  passed:              { icon: 'check', cls: 'ok',       label: 'Passed' },
  failed:              { icon: 'x',     cls: 'fail',     label: 'Failed' },
  no_tests:            { icon: 'dot',   cls: 'info',     label: 'No tests' },
  infrastructure_error: { icon: 'alert', cls: 'warning',  label: 'Infra error' },
}

/**
 * Determine the display badge for a stage, driven by `outcome` when present
 * and falling back to the legacy `state` + `exitCode` heuristics.
 */
function stageBadge(stage: ValidationStageVM): { icon: 'check' | 'x' | 'clock' | 'dot' | 'alert'; cls: string; label: string } {
  // 1. Richer outcome from the backend — take precedence
  if (stage.outcome && OUTCOME_META[stage.outcome]) {
    return OUTCOME_META[stage.outcome]
  }
  // 2. Skipped stages: check if misconfigured
  if (stage.state === 'skipped' && stage.reason?.startsWith('misconfigured:')) {
    return { icon: 'alert', cls: 'warning', label: 'Misconfigured' }
  }
  if (stage.state === 'skipped') {
    return { icon: 'dot', cls: 'neutral', label: 'Skipped' }
  }
  // 3. Legacy path — no `outcome` field
  switch (stage.state) {
    case 'passed':
      return { icon: 'check', cls: 'ok', label: 'Passed' }
    case 'failed':
      return { icon: 'x', cls: 'fail', label: 'Failed' }
    case 'active':
      return { icon: 'clock', cls: 'active', label: 'Running' }
    case 'pending':
      return { icon: 'dot', cls: 'neutral', label: 'Pending' }
    default:
      return { icon: 'dot', cls: 'neutral', label: '' }
  }
}

/** Strip the "skipped: " / "misconfigured: " prefix for display. */
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

/** Live install/build/test/lint stages with expandable streaming logs. */
export function ValidationStages({ stages, title = 'Validation' }: ValidationStagesProps) {
  const [open, setOpen] = useState<string | null>(() => {
    const running = stages.find((s) => s.state === 'active')
    const failed = stages.find((s) => s.state === 'failed')
    return (running ?? failed)?.name ?? null
  })

  return (
    <div className={styles.root}>
      <div className={styles.header}>{title}</div>
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
                    <Icon name={badge.icon} size={12} />
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
                    size={13}
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
                <pre className={styles.log}>{stage.log.join('\n')}</pre>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
