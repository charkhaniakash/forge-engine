import { Middleware } from '@reduxjs/toolkit'
import { aiEventAppended, setCurrentFile, setCurrentPhase } from '@/store/slices/workspaceActivitySlice'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'

/**
 * Middleware that automatically creates activity events when:
 * - Files are opened/created/edited
 * - Phases transition
 * - Build status changes
 */
export const activityTrackingMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action)

  // Track file operations
  if (action.type === 'workspaceEditor/setActiveFile' && action.payload) {
    const fileName = action.payload.split('/').pop() || action.payload
    store.dispatch(
      aiEventAppended({
        id: `file-${Date.now()}`,
        type: 'reading',
        label: `Viewing ${fileName}`,
        timestamp: Date.now(),
        details: action.payload,
      }),
    )
    store.dispatch(setCurrentFile(action.payload))
  }

  if (action.type === 'workspaceEditor/createFile' && action.payload) {
    const fileName = action.payload.split('/').pop() || action.payload
    store.dispatch(
      aiEventAppended({
        id: `create-${Date.now()}`,
        type: 'creating',
        label: `Creating ${fileName}`,
        timestamp: Date.now(),
        details: action.payload,
      }),
    )
  }

  if (action.type === 'workspaceEditor/deleteFile' && action.payload) {
    const fileName = action.payload.split('/').pop() || action.payload
    store.dispatch(
      aiEventAppended({
        id: `delete-${Date.now()}`,
        type: 'updating',
        label: `Deleted ${fileName}`,
        timestamp: Date.now(),
        details: action.payload,
      }),
    )
  }

  // Track phase transitions
  if (action.type === 'unifiedStream/unifiedStreamConnectionStateChanged') {
    const state = action.payload
    if (state === 'open') {
      store.dispatch(
        aiEventAppended({
          id: `connect-${Date.now()}`,
          type: 'success',
          label: 'WebSocket connected',
          timestamp: Date.now(),
        }),
      )
    }
  }

  return result
}
