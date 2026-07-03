import type { Tone } from '@/constants/status'
import styles from './ProgressBar.module.css'

export interface ProgressBarProps {
  /** 0–1 fraction. Omit for an indeterminate bar. */
  value?: number
  tone?: Tone
  height?: number
  label?: string
}

export function ProgressBar({ value, tone = 'accent', height = 6, label }: ProgressBarProps) {
  const indeterminate = value == null
  const pct = Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)
  return (
    <div className={styles.wrap}>
      {label && (
        <div className={styles.label}>
          <span>{label}</span>
          {!indeterminate && <span>{pct}%</span>}
        </div>
      )}
      <div className={styles.track} style={{ height }} role="progressbar" aria-valuenow={pct}>
        <div
          className={`${styles.fill} ${styles[tone]} ${
            indeterminate ? styles.indeterminate : ''
          }`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
