import type { ReactNode } from 'react'
import styles from './Tabs.module.css'

export interface TabItem {
  id: string
  label: ReactNode
  count?: number
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  activeId: string
  onChange: (id: string) => void
  /** 'underline' (default) for page-level, 'pill' for compact toolbars. */
  variant?: 'underline' | 'pill'
}

export function Tabs({ items, activeId, onChange, variant = 'underline' }: TabsProps) {
  return (
    <div className={`${styles.tabs} ${styles[variant]}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          aria-selected={item.id === activeId}
          disabled={item.disabled}
          className={`${styles.tab} ${item.id === activeId ? styles.active : ''}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count != null && <span className={styles.count}>{item.count}</span>}
        </button>
      ))}
    </div>
  )
}
