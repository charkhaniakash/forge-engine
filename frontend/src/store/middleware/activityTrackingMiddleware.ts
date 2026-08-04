import type { Middleware, UnknownAction } from '@reduxjs/toolkit'
import { aiEventAppended } from '@/store/slices/workspaceActivitySlice'

function isAction(v: unknown): v is UnknownAction & { payload: unknown } {
  return typeof v === 'object' && v !== null && 'type' in v
}

/**
 * Middleware that automatically creates activity events when files are
 * opened/created/edited inside the workspace editor.
 */
export const activityTrackingMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action)

  if (!isAction(action)) return result

  // Track file view
  if (
    action.type === 'workspaceEditor/setActiveFile' &&
    typeof action.payload === 'string' &&
    action.payload
  ) {
    const fileName = (action.payload as string).split('/').pop() ?? action.payload as string
    store.dispatch(
      aiEventAppended({
        id: `file-${Date.now()}`,
        type: 'tool_call',
        label: `Viewing ${fileName}`,
        ts: Date.now(),
      }),
    )
  }

  return result
}
