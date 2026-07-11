import { useEffect, type ReactNode } from 'react'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import styles from './Drawer.module.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  side?: 'right' | 'left'
  width?: number
  footer?: ReactNode
  children: ReactNode
}

export function Drawer({
  open,
  onClose,
  title,
  side = 'right',
  width = 480,
  footer,
  children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <Portal>
      <div className={styles.overlay} onMouseDown={onClose}>
        <aside
          className={`${styles.panel} ${side === 'right' ? styles.right : styles.left}`}
          style={{ width }}
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {title && (
            <div className={styles.header}>
              <div className={styles.title}>{title}</div>
              <button className={styles.close} onClick={onClose} aria-label="Close">
                <Icon name="x" size={18} />
              </button>
            </div>
          )}
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </aside>
      </div>
    </Portal>
  )
}
