import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import type { Notification, Toast, ToastVariant } from '@/types'

interface NotificationState {
  /** Transient toasts rendered by the ToastViewport. */
  toasts: Toast[]
  /** Persistent notification-centre entries. */
  notifications: Notification[]
}

const initialState: NotificationState = {
  toasts: [],
  notifications: [],
}

interface NotifyPayload {
  variant: ToastVariant
  title: string
  message?: string
  duration?: number
  /** Also record in the notification centre. */
  persist?: boolean
  href?: string
}

const notificationSlice = createSlice({
  name: 'notifications',
  initialState,
  reducers: {
    notified: {
      reducer(state, action: PayloadAction<Toast & { persist?: boolean; href?: string }>) {
        const { persist, href, ...toast } = action.payload
        state.toasts.push(toast)
        if (persist) {
          state.notifications.unshift({
            id: toast.id,
            variant: toast.variant,
            title: toast.title,
            message: toast.message,
            read: false,
            createdAt: Date.now(),
            href,
          })
        }
      },
      prepare(payload: NotifyPayload) {
        return {
          payload: {
            id: nanoid(),
            variant: payload.variant,
            title: payload.title,
            message: payload.message,
            duration: payload.duration ?? 5000,
            persist: payload.persist,
            href: payload.href,
          },
        }
      },
    },
    toastDismissed(state, action: PayloadAction<string>) {
      state.toasts = state.toasts.filter((t) => t.id !== action.payload)
    },
    notificationRead(state, action: PayloadAction<string>) {
      const n = state.notifications.find((x) => x.id === action.payload)
      if (n) n.read = true
    },
    allNotificationsRead(state) {
      state.notifications.forEach((n) => (n.read = true))
    },
    notificationsCleared(state) {
      state.notifications = []
    },
  },
})

export const {
  notified,
  toastDismissed,
  notificationRead,
  allNotificationsRead,
  notificationsCleared,
} = notificationSlice.actions
export default notificationSlice.reducer
