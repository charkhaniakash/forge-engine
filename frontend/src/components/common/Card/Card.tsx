import type { HTMLAttributes, ReactNode } from 'react'
import styles from './Card.module.css'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean
  interactive?: boolean
}

export function Card({
  padded = true,
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        styles.card,
        padded && styles.padded,
        interactive && styles.interactive,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.title}>{title}</div>
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  )
}
