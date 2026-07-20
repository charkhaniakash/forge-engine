import { Icon } from '@/components/common'
import type { IconName } from '@/components/common'
import styles from './MissionHero.module.css'

export type HeroTone = 'active' | 'success' | 'danger' | 'neutral'

export interface MissionHeroProps {
  /** Big line — what the agent is doing right now, or the terminal outcome. */
  title: string
  /** Supporting line under the title. */
  subtitle?: string
  /** 0..1 pipeline progress. */
  progress: number
  /** Pulsing dot while a phase is streaming. */
  live?: boolean
  tone?: HeroTone
  /** Small icon. */
  icon?: IconName
  /** Right-aligned meta chips (status badge, PR link…). */
  right?: React.ReactNode
}

/**
 * Devin-style spec/plan card: a clean, minimal card at the top showing the
 * current task description and status. No progress ring — just the task intent
 * with a status badge and live indicator.
 */
export function MissionHero({ title, subtitle, progress, live = false, tone = 'neutral', right }: MissionHeroProps) {
  return (
    <div className={`${styles.hero} ${styles[`tone_${tone}`]}`}>
      <div className={styles.left}>
        <div className={styles.avatar}>
          <Icon name="sparkles" size={16} />
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          {live && <span className={styles.liveDot} />}
          <span className={styles.title}>{title}</span>
        </div>
        {subtitle && (
          <p className={styles.subtitle}>{subtitle}</p>
        )}
        {progress > 0 && progress < 1 && (
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      {right && <div className={styles.right}>{right}</div>}
    </div>
  )
}
