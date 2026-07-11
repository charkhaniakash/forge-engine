import { baseApi } from './baseApi'
import type {
  CodeDiff,
  ExecutionEvent,
  ExecutionSnapshot,
  TaskExecution,
} from '@/types'

export const executionApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getExecution: builder.query<
      ExecutionSnapshot,
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/execution`,
      providesTags: (_r, _e, { taskId }) => [{ type: 'Execution', id: taskId }],
    }),

    getExecutionEvents: builder.query<
      ExecutionEvent[],
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/execution/events`,
      transformResponse: (res: { events?: ExecutionEvent[] }) =>
        res.events ?? [],
      providesTags: (_r, _e, { taskId }) => [{ type: 'Execution', id: taskId }],
    }),

    getExecutionDiffs: builder.query<
      CodeDiff[],
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/execution/diffs`,
      transformResponse: (res: { diffs?: CodeDiff[] }) => res.diffs ?? [],
      providesTags: (_r, _e, { taskId }) => [{ type: 'Diff', id: taskId }],
    }),

    startExecution: builder.mutation<
      TaskExecution,
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/execute`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Execution', id: taskId },
        { type: 'Task', id: taskId },
      ],
    }),

    cancelExecution: builder.mutation<
      { status?: string },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/execution/cancel`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [{ type: 'Execution', id: taskId }],
    }),
  }),
})

export const {
  useGetExecutionQuery,
  useGetExecutionEventsQuery,
  useGetExecutionDiffsQuery,
  useStartExecutionMutation,
  useCancelExecutionMutation,
} = executionApi
