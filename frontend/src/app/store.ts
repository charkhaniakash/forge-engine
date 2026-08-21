import { configureStore, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit'
import { baseApi } from '@/services/api/baseApi'
import { websocketMiddleware } from '@/store/middleware/websocketMiddleware'
import { unifiedStreamBridgeMiddleware } from '@/store/middleware/unifiedStreamBridgeMiddleware'
import { reconnectPersistenceMiddleware } from '@/store/middleware/reconnectPersistenceMiddleware'
import { activityTrackingMiddleware } from '@/store/middleware/activityTrackingMiddleware'
import authReducer from '@/store/slices/authSlice'
import uiReducer from '@/store/slices/uiSlice'
import notificationReducer from '@/store/slices/notificationSlice'
import websocketReducer from '@/store/slices/websocketSlice'
import streamReducer from '@/store/slices/streamSlice'
import unifiedStreamReducer from '@/store/slices/unifiedStreamSlice'
import reconnectSessionReducer from '@/store/slices/reconnectSessionSlice'
import optimisticReducer from '@/store/slices/optimisticSlice'
import workspaceEditorReducer from '@/store/slices/workspaceEditorSlice'
import workspaceTerminalReducer from '@/store/slices/workspaceTerminalSlice'
import workspaceActivityReducer from '@/store/slices/workspaceActivitySlice'

// Importing the domain API files here ensures their `injectEndpoints` side
// effects run so the hooks are registered against baseApi.
import '@/services/api/authApi'
import '@/services/api/organizationApi'
import '@/services/api/repositoryApi'
import '@/services/api/qaApi'
import '@/services/api/taskApi'
import '@/services/api/executionApi'
import '@/services/api/workspaceApi'
import '@/services/api/repairApi'
import '@/services/api/publishingApi'
import '@/services/api/workspaceEditorApi'
import '@/services/api/llmApi'

const reducer = {
  [baseApi.reducerPath]: baseApi.reducer,
  auth: authReducer,
  ui: uiReducer,
  notifications: notificationReducer,
  websocket: websocketReducer,
  stream: streamReducer,
  unifiedStream: unifiedStreamReducer,
  reconnectSession: reconnectSessionReducer,
  optimistic: optimisticReducer,
  workspaceEditor: workspaceEditorReducer,
  workspaceTerminal: workspaceTerminalReducer,
  workspaceActivity: workspaceActivityReducer,
}

// Build store with explicit typing to avoid circular reference
export const store = configureStore({
  reducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(
      baseApi.middleware,
      websocketMiddleware,
      unifiedStreamBridgeMiddleware,
      reconnectPersistenceMiddleware,
      activityTrackingMiddleware,
    ),
})

export type RootState = {
  [K in keyof typeof reducer]: ReturnType<typeof reducer[K]>
}
export type AppDispatch = typeof store.dispatch
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  RootState,
  unknown,
  UnknownAction
>
