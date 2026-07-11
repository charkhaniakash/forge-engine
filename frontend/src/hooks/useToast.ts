import { useCallback } from 'react'
import { useAppDispatch } from '@/app/hooks'
import { notified } from '@/store/slices/notificationSlice'
import type { ToastVariant } from '@/types'

interface NotifyOptions {
  message?: string
  duration?: number
  persist?: boolean
  href?: string
}

/** Ergonomic wrapper over the notification slice for firing toasts. */
export function useToast() {
  const dispatch = useAppDispatch()
  const fire = useCallback(
    (variant: ToastVariant, title: string, opts?: NotifyOptions) => {
      dispatch(notified({ variant, title, ...opts }))
    },
    [dispatch],
  )

  return {
    info: (title: string, opts?: NotifyOptions) => fire('info', title, opts),
    success: (title: string, opts?: NotifyOptions) => fire('success', title, opts),
    warning: (title: string, opts?: NotifyOptions) => fire('warning', title, opts),
    error: (title: string, opts?: NotifyOptions) => fire('error', title, opts),
  }
}
