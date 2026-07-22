import { Icon } from '@/components/common'
import type { RepairAttemptVM } from './model'
import styles from './RepairAttemptCard.module.css'

export interface RepairAttemptCardProps {
  attempt: RepairAttemptVM
}

/** Human-centered labels for repair outcomes — no "failed" */
const OUTCOME_LABEL: Record<string, string> = {
  passed: 'Resolved',
  improved: 'Partially resolved',
  no_change: 'No change',
  regressed: 'Introduced new issue',
  cannot_repair: 'Needs developer attention',
}

const OUTCOME_CLS: Record<string, string> = {
  passed: 'resolved',
  improved: 'partial',
  no_change: 'noChange',
  regressed: 'regressed',
  cannot_repair: 'escalated',
}

export function RepairAttemptCard({ attempt }: RepairAttemptCardProps) {
  const label = attempt.outcome ? OUTCOME_LABEL[attempt.outcome] ?? '' : ''
  const cls = attempt.outcome ? OUTCOME_CLS[attempt.outcome] ?? '' : ''
  const pct = attempt.confidence != null ? Math.round(attempt.confidence * 100) : null

  return (
    <div className={styles.card} data-outcome={attempt.outcome}>
      <div className={styles.head}>
        <span className={styles.iconWrap}>
          <Icon name="tool" size={13} />
        </span>
        <span className={styles.title}>
          Attempt {attempt.attempt}
        </span>
        {label && (
          <span className={`${styles.outcomeChip} ${styles[cls]}`}>{label}</span>
        )}
      </div>

      {attempt.rootCause && (
        <p className={styles.rootCause}>{attempt.rootCause}</p>
      )}

      <div className={styles.meta}>
        {attempt.strategy && (
          <span className={styles.metaPill}>
            {attempt.strategy === 'targeted_fix' ? 'Targeted fix' : attempt.strategy}
          </span>
        )}
        {pct != null && (
          <span className={styles.metaPill}>
            {pct}% confident
          </span>
        )}
        {(attempt.errorsBefore != null || attempt.errorsAfter != null) && (
          <span className={styles.metaPill}>
            {attempt.errorsBefore ?? '—'} → {attempt.errorsAfter ?? '—'} issues
          </span>
        )}
      </div>

      {attempt.filesModified.length > 0 && (
        <div className={styles.files}>
          {attempt.filesModified.map((f) => (
            <span key={f} className={styles.file}>
              <Icon name="file" size={10} /> {f}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
