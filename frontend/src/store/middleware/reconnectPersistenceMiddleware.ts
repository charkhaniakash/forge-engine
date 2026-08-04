import type { Middleware } from '@reduxjs/toolkit'

/**
 * Saves the latest unified-stream seq numbers to localStorage on every
 * envelope, so reconnect can resume from where it left off across page reloads.
 */
export const reconnectPersistenceMiddleware: Middleware =
  (store) => (next) => (action) => {
    const result = next(action)

    if (
      typeof action === 'object' &&
      action !== null &&
      (action as { type?: string }).type === 'unifiedStream/unifiedStreamEnvelopeReceived'
    ) {
      try {
        const state = store.getState()
        const lastSeq = state?.unifiedStream?.lastSeqPerChannel
        if (lastSeq && Object.keys(lastSeq).length > 0) {
          localStorage.setItem('forge-reconnect-seq', JSON.stringify(lastSeq))
        }
      } catch {
        /* ignore localStorage failures */
      }
    }

    return result
  }

export function loadSavedReconnectSeq(): Record<string, number> {
  try {
    const raw = localStorage.getItem('forge-reconnect-seq')
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function clearSavedReconnectSeq(): void {
  localStorage.removeItem('forge-reconnect-seq')
}
