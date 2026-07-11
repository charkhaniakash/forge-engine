import { baseApi } from './baseApi'
import type { AskRequest, QAMessage, QASession } from '@/types'

interface SessionDetail extends QASession {
  messages: QAMessage[]
}

export const qaApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listSessions: builder.query<QASession[], string>({
      query: (repoId) => `/repos/${repoId}/qa/sessions`,
      transformResponse: (res: { sessions?: QASession[] }) => res.sessions ?? [],
      providesTags: (_r, _e, repoId) => [{ type: 'QASession', id: repoId }],
    }),

    getSession: builder.query<
      SessionDetail,
      { repoId: string; sessionId: string }
    >({
      query: ({ repoId, sessionId }) =>
        `/repos/${repoId}/qa/sessions/${sessionId}`,
      providesTags: (_r, _e, { sessionId }) => [
        { type: 'QAMessage', id: sessionId },
      ],
    }),

    createSession: builder.mutation<QASession, string>({
      query: (repoId) => ({
        url: `/repos/${repoId}/qa/sessions`,
        method: 'POST',
      }),
      invalidatesTags: (_r, _e, repoId) => [{ type: 'QASession', id: repoId }],
    }),

    ask: builder.mutation<
      { message: QAMessage },
      { repoId: string; sessionId: string } & AskRequest
    >({
      query: ({ repoId, sessionId, ...body }) => ({
        url: `/repos/${repoId}/qa/sessions/${sessionId}/ask`,
        method: 'POST',
        body,
      }),
      // The persisted messages are refetched after streaming completes.
      invalidatesTags: (_r, _e, { sessionId, repoId }) => [
        { type: 'QAMessage', id: sessionId },
        { type: 'QASession', id: repoId },
      ],
    }),
  }),
})

export const {
  useListSessionsQuery,
  useGetSessionQuery,
  useCreateSessionMutation,
  useAskMutation,
} = qaApi
