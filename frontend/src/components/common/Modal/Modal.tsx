import { useEffect, type ReactNode } from 'react'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import styles from './Modal.module.css'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <Portal>
      <div className={styles.overlay} onMouseDown={onClose}>
        <div
          className={`${styles.dialog} ${styles[size]}`}
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(title || description) && (
            <div className={styles.header}>
              <div>
                {title && <div className={styles.title}>{title}</div>}
                {description && <div className={styles.description}>{description}</div>}
              </div>
              <button className={styles.close} onClick={onClose} aria-label="Close">
                <Icon name="x" size={18} />
              </button>
            </div>
          )}
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>
      </div>
    </Portal>
  )
}
