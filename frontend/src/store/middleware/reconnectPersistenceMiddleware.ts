import type { Middleware } from '@reduxjs/toolkit'
import { updateSessionSeq } from '@/store/slices/reconnectSessionSlice'
import type { RootState } from '@/app/store'

/**
 * Middleware that automatically persists lastSeq to localStorage on every event.
 * Ensures reconnect can recover even after page reload.
 */
export const reconnectPersistenceMiddleware: Middleware<{}, RootState> =
  (store) => (next) => (action) => {
    const result = next(action)

    // When an envelope is received, update localStorage with latest seq
    if (action.type === 'unifiedStream/envelopeReceived') {
      const state = store.getState()
      const unifiedStream = state.unifiedStream

      if (unifiedStream.lastSeq) {
        // Save to localStorage for recovery across page reloads
        localStorage.setItem(
          'forge-reconnect-session',
          JSON.stringify(unifiedStream.lastSeq),
        )
      }
    }

    return result
  }

/**
 * Retrieve saved lastSeq from localStorage (for recovery after page reload).
 */
export function loadSavedReconnectSession(): Record<string, number> {
  try {
    const saved = localStorage.getItem('forge-reconnect-session')
    return saved ? JSON.parse(saved) : {}
  } catch {
    return {}
  }
}

/**
 * Clear saved reconnect session (called on logout).
 */
export function clearSavedReconnectSession(): void {
  localStorage.removeItem('forge-reconnect-session')
}
