import type { ReactNode } from 'react'
import styles from './Badge.module.css'
import type { Tone } from '@/constants/status'

export interface BadgeProps {
  tone?: Tone
  /** Show a leading status dot. */
  dot?: boolean
  size?: 'sm' | 'md'
  children: ReactNode
}

export function Badge({ tone = 'neutral', dot = false, size = 'md', children }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]} ${styles[size]}`}>
      {dot && <span className={styles.dot} />}
      {children}
    </span>
  )
}
