import { configureStore } from '@reduxjs/toolkit'
import { baseApi } from '@/services/api/baseApi'
import { websocketMiddleware } from '@/store/middleware/websocketMiddleware'
import { unifiedStreamBridgeMiddleware } from '@/store/middleware/unifiedStreamBridgeMiddleware'
import { reconnectPersistenceMiddleware } from '@/store/middleware/reconnectPersistenceMiddleware'
import authReducer from '@/store/slices/authSlice'
import uiReducer from '@/store/slices/uiSlice'
import notificationReducer from '@/store/slices/notificationSlice'
import websocketReducer from '@/store/slices/websocketSlice'
import streamReducer from '@/store/slices/streamSlice'
import unifiedStreamReducer from '@/store/slices/unifiedStreamSlice'
import reconnectSessionReducer from '@/store/slices/reconnectSessionSlice'
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

export const store = configureStore({
  reducer: {
    [baseApi.reducerPath]: baseApi.reducer,
    auth: authReducer,
    ui: uiReducer,
    notifications: notificationReducer,
    websocket: websocketReducer,
    stream: streamReducer,
    unifiedStream: unifiedStreamReducer,
    reconnectSession: reconnectSessionReducer,
    workspaceEditor: workspaceEditorReducer,
    workspaceTerminal: workspaceTerminalReducer,
    workspaceActivity: workspaceActivityReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(
      baseApi.middleware,
      websocketMiddleware,
      unifiedStreamBridgeMiddleware,
      reconnectPersistenceMiddleware,
    ),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
