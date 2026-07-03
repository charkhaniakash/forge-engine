import { baseApi } from './baseApi'
import type { IndexStatus, Repository } from '@/types'

export const repositoryApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listRepos: builder.query<Repository[], void>({
      query: () => '/github/repos',
      providesTags: (result) =>
        result
          ? [
              ...result.map((r) => ({ type: 'Repository' as const, id: r.id })),
              { type: 'Repository' as const, id: 'LIST' },
            ]
          : [{ type: 'Repository' as const, id: 'LIST' }],
    }),

    getInstallUrl: builder.query<{ url: string }, void>({
      query: () => '/github/install/url',
    }),

    linkInstallation: builder.mutation<
      { message?: string },
      { installation_id: string }
    >({
      query: (body) => ({
        url: '/github/installations/link',
        method: 'POST',
        body,
      }),
      invalidatesTags: [{ type: 'Repository', id: 'LIST' }],
    }),

    syncRepos: builder.mutation<{ message?: string }, void>({
      query: () => ({ url: '/github/sync', method: 'POST' }),
      invalidatesTags: [{ type: 'Repository', id: 'LIST' }],
    }),

    getIndexStatus: builder.query<IndexStatus, string>({
      query: (repoId) => `/github/repos/${repoId}/index/status`,
      providesTags: (_r, _e, repoId) => [{ type: 'IndexStatus', id: repoId }],
    }),

    triggerIndex: builder.mutation<{ message?: string }, string>({
      query: (repoId) => ({
        url: `/github/repos/${repoId}/index/trigger`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, repoId) => [{ type: 'IndexStatus', id: repoId }],
    }),
  }),
})

export const {
  useListReposQuery,
  useGetInstallUrlQuery,
  useLazyGetInstallUrlQuery,
  useLinkInstallationMutation,
  useSyncReposMutation,
  useGetIndexStatusQuery,
  useTriggerIndexMutation,
} = repositoryApi
