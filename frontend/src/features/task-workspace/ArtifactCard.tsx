import type { ReactNode } from 'react'
import { Accordion, Icon } from '@/components/common'
import type { IconName } from '@/components/common'
import styles from './ArtifactCard.module.css'

export interface ArtifactCardProps {
  icon: IconName
  title: ReactNode
  subtitle?: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
  /** Open behind the collapsed summary — reserve for what still needs attention or just finished. */
  defaultOpen?: boolean
  right?: ReactNode
  children: ReactNode
}

/**
 * The one shared "artifact" shell for plan/files/validation/repair/publish
 * entries in the Mission thread — a compact collapsed summary line by
 * default, with the full detail (steps, diffs, logs, attempts) tucked behind
 * it. Backend phase names never appear here; each call site supplies a plain
 * outcome title like "Modified 4 files" or "Validation passed".
 */
export function ArtifactCard({ icon, title, subtitle, tone = 'neutral', defaultOpen = false, right, children }: ArtifactCardProps) {
  return (
    <Accordion
      className={`${styles.card} ${styles[`tone_${tone}`] ?? ''}`}
      defaultOpen={defaultOpen}
      right={right}
      title={
        <span className={styles.title}>
          <Icon name={icon} size={15} className={styles.icon} /> {title}
        </span>
      }
      subtitle={subtitle}
    >
      {children}
    </Accordion>
  )
}
