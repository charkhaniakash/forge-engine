import { Badge, Icon } from '@/components/common'
import { RISK_LEVEL, resolveStatus } from '@/constants/status'
import type { PlanStep } from '@/types'
import styles from './PlanStepCard.module.css'

const TYPE_ICON = {
  edit: 'file',
  test: 'check',
  verify: 'check',
  manual: 'alert',
} as const

export interface PlanStepCardProps {
  step: PlanStep
  index: number
}

export function PlanStepCard({ step, index }: PlanStepCardProps) {
  const risk = resolveStatus(RISK_LEVEL, step.estimated_risk)
  return (
    <div className={styles.card}>
      <div className={styles.rail}>
        <span className={styles.order}>{index + 1}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.title}>{step.title}</span>
          <div className={styles.tags}>
            <Badge tone="neutral" size="sm">
              <Icon name={TYPE_ICON[step.type] ?? 'file'} size={11} /> {step.type}
            </Badge>
            <Badge tone={risk.tone} size="sm">
              {risk.label} risk
            </Badge>
            {step.user_edited && (
              <Badge tone="accent" size="sm">
                edited
              </Badge>
            )}
          </div>
        </div>
        {step.description && <p className={styles.desc}>{step.description}</p>}
        {step.affected_files.length > 0 && (
          <div className={styles.files}>
            {step.affected_files.map((f) => (
              <span key={f} className={styles.file}>
                <Icon name="file" size={11} /> {f}
              </span>
            ))}
          </div>
        )}
        {step.depends_on.length > 0 && (
          <div className={styles.deps}>
            Depends on: {step.depends_on.join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}
