import { baseApi } from './baseApi'
import type { PublishingSession } from '@/types/publishing'

/**
 * Phase 10 — Publishing REST endpoints. Same injection pattern as repairApi /
 * validationApi: one shared baseApi, live progress comes over the dedicated
 * publishing WebSocket (usePublishingStream), not from polling.
 */
export const publishingApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    startPublish: builder.mutation<
      { status: string },
      { repoId: string; taskId: string; draftMode?: boolean }
    >({
      query: ({ repoId, taskId, draftMode }) => ({
        url: `/repos/${repoId}/tasks/${taskId}/publish`,
        method: 'POST',
        body: { draft_mode: Boolean(draftMode) },
      }),
      invalidatesTags: (_r, _e, { taskId }) => [
        { type: 'Execution', id: `publish-${taskId}` },
      ],
    }),

    getPublishSession: builder.query<
      { session: PublishingSession | null },
      { repoId: string; taskId: string }
    >({
      query: ({ repoId, taskId }) =>
        `/repos/${repoId}/tasks/${taskId}/publish`,
      providesTags: (_r, _e, { taskId }) => [
        { type: 'Execution', id: `publish-${taskId}` },
      ],
    }),
  }),
})

export const { useStartPublishMutation, useGetPublishSessionQuery } = publishingApi
