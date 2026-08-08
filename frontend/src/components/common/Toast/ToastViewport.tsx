import { useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { toastDismissed } from '@/store/slices/notificationSlice'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import type { IconName } from '../Icon/Icon'
import type { Toast, ToastVariant } from '@/types'
import { cn } from '@/lib/utils'

const ICON: Record<ToastVariant, IconName> = {
  info: 'dot',
  success: 'check',
  warning: 'alert',
  error: 'alert',
}

const VARIANT: Record<ToastVariant, { border: string; icon: string }> = {
  info: { border: 'border-l-info', icon: 'text-info' },
  success: { border: 'border-l-success', icon: 'text-success' },
  warning: { border: 'border-l-warning', icon: 'text-warning' },
  error: { border: 'border-l-destructive', icon: 'text-destructive' },
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (!toast.duration) return
    const t = setTimeout(onClose, toast.duration)
    return () => clearTimeout(t)
  }, [toast.duration, onClose])

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border border-l-[3px] border-line-strong bg-surface-3 px-4 py-3 shadow-lg animate-in fade-in-0',
        VARIANT[toast.variant].border,
      )}
      role="status"
    >
      <Icon
        name={ICON[toast.variant]}
        size={16}
        className={cn('mt-0.5 flex-shrink-0', VARIANT[toast.variant].icon)}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{toast.title}</div>
        {toast.message && (
          <div className="mt-0.5 text-xs break-words text-fg-muted">{toast.message}</div>
        )}
      </div>
      <button
        className="flex-shrink-0 cursor-pointer p-0.5 text-fg-subtle hover:text-fg"
        onClick={onClose}
        aria-label="Dismiss"
      >
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
      <div className="fixed right-5 bottom-5 z-[var(--z-toast)] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dispatch(toastDismissed(t.id))} />
        ))}
      </div>
    </Portal>
  )
}
