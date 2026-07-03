import { useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { toastDismissed } from '@/store/slices/notificationSlice'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import type { IconName } from '../Icon/Icon'
import type { Toast, ToastVariant } from '@/types'
import styles from './Toast.module.css'

const ICON: Record<ToastVariant, IconName> = {
  info: 'dot',
  success: 'check',
  warning: 'alert',
  error: 'alert',
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (!toast.duration) return
    const t = setTimeout(onClose, toast.duration)
    return () => clearTimeout(t)
  }, [toast.duration, onClose])

  return (
    <div className={`${styles.toast} ${styles[toast.variant]}`} role="status">
      <Icon name={ICON[toast.variant]} size={16} className={styles.icon} />
      <div className={styles.text}>
        <div className={styles.title}>{toast.title}</div>
        {toast.message && <div className={styles.message}>{toast.message}</div>}
      </div>
      <button className={styles.close} onClick={onClose} aria-label="Dismiss">
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

/** Renders live toasts from the notification slice. Mount once in the app root. */
export function ToastViewport() {
  const toasts = useAppSelector((s) => s.notifications.toasts)
  const dispatch = useAppDispatch()
  if (toasts.length === 0) return null
  return (
    <Portal>
      <div className={styles.viewport}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dispatch(toastDismissed(t.id))} />
        ))}
      </div>
    </Portal>
  )
}
