import { Icon } from '@/components/common'
import type { IconName } from '@/components/common'
import styles from './MissionHero.module.css'

export type HeroTone = 'active' | 'success' | 'danger' | 'neutral'

export interface MissionHeroProps {
  /** Big line — what the agent is doing right now, or the terminal outcome. */
  title: string
  /** Supporting line under the title. */
  subtitle?: string
  /** 0..1 pipeline progress. When live this fills the ring; on terminal states use 1. */
  progress: number
  /** Pulsing ring + "LIVE" chip while a phase is streaming. */
  live?: boolean
  tone?: HeroTone
  /** Small icon in the centre of the ring (defaults per tone). */
  icon?: IconName
  /** Right-aligned meta chips (status badge, PR link…). */
  right?: React.ReactNode
}

const R = 26
const C = 2 * Math.PI * R

/**
 * The status "hero" that opens the mission surface — a circular progress ring
 * with the current phase title, mirroring the reference agent view. Honest:
 * the ring tracks the mission's real position in the pipeline, not a fabricated
 * ETA.
 */
export function MissionHero({ title, subtitle, progress, live = false, tone = 'neutral', icon, right }: MissionHeroProps) {
  const pct = Math.max(0, Math.min(1, progress))
  const dash = C * (1 - pct)
  const centerIcon: IconName =
    icon ?? (tone === 'success' ? 'check' : tone === 'danger' ? 'alert' : 'sparkles')

  return (
    <div className={`${styles.hero} ${styles[`tone_${tone}`]}`}>
      <div className={`${styles.ringWrap} ${live ? styles.ringLive : ''}`}>
        <svg viewBox="0 0 60 60" className={styles.ring} aria-hidden="true">
          <circle cx="30" cy="30" r={R} className={styles.track} />
          <circle
            cx="30"
            cy="30"
            r={R}
            className={styles.progress}
            strokeDasharray={C}
            strokeDashoffset={dash}
            transform="rotate(-90 30 30)"
          />
        </svg>
        <span className={styles.ringLabel}>
          {live ? <Icon name={centerIcon} size={18} /> : `${Math.round(pct * 100)}%`}
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.titleRow}>
          {live && <span className={styles.pulse} />}
          <span className={styles.title}>{title}</span>
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>

      {right && <div className={styles.right}>{right}</div>}
    </div>
  )
}
