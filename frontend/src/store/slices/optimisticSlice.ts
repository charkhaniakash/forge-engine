import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

interface OptimisticState {
  // Track optimistic loading states per taskId
  // e.g., { "task-123": { approving: true, replanning: false } }
  mutations: Record<string, Record<string, boolean>>
}

const initialState: OptimisticState = {
  mutations: {},
}

const optimisticSlice = createSlice({
  name: 'optimistic',
  initialState,
  reducers: {
    // Set optimistic mutation state
    setOptimistic(
      state,
      action: PayloadAction<{ taskId: string; mutation: string; loading: boolean }>,
    ) {
      const { taskId, mutation, loading } = action.payload
      if (!state.mutations[taskId]) {
        state.mutations[taskId] = {}
      }
      state.mutations[taskId][mutation] = loading
    },

    // Clear all optimistic states for a task
    clearTaskOptimistic(state, action: PayloadAction<string>) {
      delete state.mutations[action.payload]
    },

    // Clear all optimistic states
    clearAllOptimistic(state) {
      state.mutations = {}
    },
  },
})

export const { setOptimistic, clearTaskOptimistic, clearAllOptimistic } = optimisticSlice.actions
export default optimisticSlice.reducer
