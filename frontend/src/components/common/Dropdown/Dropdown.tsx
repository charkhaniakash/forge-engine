import { useRef, useState, type ReactNode } from 'react'
import { useClickOutside } from '@/hooks/useClickOutside'
import styles from './Dropdown.module.css'

export interface DropdownItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  /** Render a divider above this item. */
  divider?: boolean
}

export interface DropdownProps {
  /** The trigger element. Receives an onClick to toggle the menu. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  items: DropdownItem[]
  align?: 'start' | 'end'
  header?: ReactNode
  width?: number
}

export function Dropdown({ trigger, items, align = 'end', header, width = 220 }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)

  return (
    <div className={styles.root} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={`${styles.menu} ${align === 'end' ? styles.alignEnd : styles.alignStart}`}
          style={{ width }}
          role="menu"
        >
          {header && <div className={styles.header}>{header}</div>}
          {items.map((item) => (
            <div key={item.id}>
              {item.divider && <div className={styles.divider} />}
              <button
                role="menuitem"
                className={`${styles.item} ${item.danger ? styles.danger : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.()
                  setOpen(false)
                }}
              >
                {item.icon && <span className={styles.icon}>{item.icon}</span>}
                <span className={styles.itemLabel}>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
