import { useState, type ReactNode } from 'react'
import styles from './Tooltip.module.css'

export interface TooltipProps {
  content: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
}

/** Lightweight CSS-positioned tooltip. Wraps a single focusable/hoverable child. */
export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  if (!content) return <>{children}</>
  return (
    <span
      className={styles.wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span role="tooltip" className={`${styles.bubble} ${styles[side]}`}>
          {content}
        </span>
      )}
    </span>
  )
}
