import { baseApi } from './baseApi'
import type { Workspace, WorkspaceLog } from '@/types'

export const workspaceApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getWorkspace: builder.query<
      Workspace | null,
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/workspace`,
      providesTags: (_r, _e, { taskId }) => [
        { type: 'Workspace', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),

    getWorkspaceLogs: builder.query<
      WorkspaceLog[],
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/workspace/logs`,
      transformResponse: (res: { logs?: WorkspaceLog[] }) => res.logs ?? [],
      providesTags: (_r, _e, { taskId }) => [
        { type: 'WorkspaceLog', id: taskId },
      ],
    }),

    provisionWorkspace: builder.mutation<
      Workspace,
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/workspace`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Workspace', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),

    destroyWorkspace: builder.mutation<
      { status?: string },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/workspace`,
        method: 'DELETE',
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Workspace', id: taskId },
        { type: 'Execution', id: taskId },
      ],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useGetWorkspaceLogsQuery,
  useProvisionWorkspaceMutation,
  useDestroyWorkspaceMutation,
} = workspaceApi
