import { useState, type ReactNode } from 'react'
import { Icon } from '../Icon/Icon'
import styles from './Accordion.module.css'

export interface AccordionProps {
  title: ReactNode
  subtitle?: ReactNode
  defaultOpen?: boolean
  right?: ReactNode
  children: ReactNode
  /** Extra class on the root — lets consumers fit the accordion into a denser context. */
  className?: string
}

export function Accordion({
  title,
  subtitle,
  defaultOpen = false,
  right,
  children,
  className,
}: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      <button
        className={styles.header}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Icon
          name="chevronRight"
          size={16}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
        />
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        {right && <span className={styles.right}>{right}</span>}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  )
}
