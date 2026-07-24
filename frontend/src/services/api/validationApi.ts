import { baseApi } from './baseApi'
import type {
  ValidationDiagnostic,
  ValidationSnapshot,
} from '@/types'

export const validationApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getValidation: builder.query<
      ValidationSnapshot,
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/validation`,
      providesTags: (_r, _e, { taskId }) => [
        { type: 'Validation', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),

    getValidationDiagnostics: builder.query<
      ValidationDiagnostic[],
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/validation/diagnostics`,
      transformResponse: (res: { diagnostics?: ValidationDiagnostic[] }) =>
        res.diagnostics ?? [],
      providesTags: (_r, _e, { taskId }) => [
        { type: 'Validation', id: `diags-${taskId}` },
      ],
    }),

    startValidation: builder.mutation<
      { task_id: string; status: string },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/validate`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Validation', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),
  }),
})

export const {
  useGetValidationQuery,
  useGetValidationDiagnosticsQuery,
  useStartValidationMutation,
} = validationApi
