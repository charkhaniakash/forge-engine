import { Badge, Icon } from '@/components/common'
import { resolveStatus } from '@/constants/status'
import type { RepairAttemptVM } from './model'
import styles from './RepairAttemptCard.module.css'

export interface RepairAttemptCardProps {
  attempt: RepairAttemptVM
}

const OUTCOME_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  passed: 'success',
  improved: 'success',
  no_change: 'warning',
  regressed: 'danger',
  cannot_repair: 'danger',
}

export function RepairAttemptCard({ attempt }: RepairAttemptCardProps) {
  const tone = attempt.outcome ? OUTCOME_TONE[attempt.outcome] ?? 'neutral' : 'neutral'
  const pct = attempt.confidence != null ? Math.round(attempt.confidence * 100) : null

  return (
    <div className={styles.card} data-state={attempt.state}>
      <div className={styles.head}>
        <span className={styles.title}>
          <Icon name="repair" size={15} /> Repair attempt {attempt.attempt}
        </span>
        {attempt.outcome && (
          <Badge tone={tone} size="sm">
            {resolveStatus({}, attempt.outcome).label}
          </Badge>
        )}
      </div>

      {attempt.rootCause && <p className={styles.rootCause}>{attempt.rootCause}</p>}

      <div className={styles.meta}>
        {attempt.strategy && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Strategy</span>
            <span className={styles.metaValue}>{attempt.strategy}</span>
          </div>
        )}
        {pct != null && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Confidence</span>
            <span className={styles.confidence}>
              <span className={styles.confidenceTrack}>
                <span className={styles.confidenceFill} style={{ width: `${pct}%` }} />
              </span>
              {pct}%
            </span>
          </div>
        )}
        {(attempt.errorsBefore != null || attempt.errorsAfter != null) && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Errors</span>
            <span className={styles.metaValue}>
              {attempt.errorsBefore ?? '—'} <Icon name="chevronRight" size={11} /> {attempt.errorsAfter ?? '—'}
            </span>
          </div>
        )}
      </div>

      {attempt.filesModified.length > 0 && (
        <div className={styles.files}>
          {attempt.filesModified.map((f) => (
            <span key={f} className={styles.file}>
              <Icon name="file" size={11} /> {f}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
