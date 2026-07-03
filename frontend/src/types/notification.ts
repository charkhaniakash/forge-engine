import type { ID } from './common'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: ID
  variant: ToastVariant
  title: string
  message?: string
  /** Auto-dismiss after this many ms. 0 = sticky. */
  duration?: number
}

export interface Notification {
  id: ID
  variant: ToastVariant
  title: string
  message?: string
  read: boolean
  createdAt: number
  /** Optional in-app route to navigate to when clicked. */
  href?: string
}
