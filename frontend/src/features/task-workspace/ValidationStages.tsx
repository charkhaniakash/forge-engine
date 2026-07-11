import { useState } from 'react'
import { Icon } from '@/components/common'
import type { ValidationStageVM, PhaseState } from './model'
import styles from './ValidationStages.module.css'

export interface ValidationStagesProps {
  stages: ValidationStageVM[]
  /** Auto-expand the stage that is currently running or failed. */
  title?: string
}

const ICON: Record<PhaseState, { name: 'check' | 'x' | 'clock' | 'dot'; cls: string }> = {
  passed: { name: 'check', cls: 'ok' },
  failed: { name: 'x', cls: 'fail' },
  active: { name: 'clock', cls: 'active' },
  pending: { name: 'dot', cls: 'pending' },
  skipped: { name: 'dot', cls: 'pending' },
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
          const meta = ICON[stage.state]
          const expanded = open === stage.name
          return (
            <div key={stage.name} className={styles.stage} data-state={stage.state}>
              <button
                className={styles.stageHead}
                onClick={() => setOpen(expanded ? null : stage.name)}
              >
                <span className={`${styles.badge} ${styles[meta.cls]}`}>
                  {stage.state === 'active' ? (
                    <span className={styles.spinner} />
                  ) : (
                    <Icon name={meta.name} size={12} />
                  )}
                </span>
                <span className={styles.stageName}>{stage.name}</span>
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
