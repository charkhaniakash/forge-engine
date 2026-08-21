import { baseApi } from './baseApi'

export interface LLMProvider {
  id: string
  name: string
  docs_url: string
  requires_key: boolean
  default_model: string
  models: string[]
  hint: string
}

export interface LLMCredential {
  id: string
  org_id: string
  user_id: string
  provider: string
  model: string
  key_hint: string
  validated_at?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface LLMConfigResponse {
  configured: boolean
  active: LLMCredential | null
  saved: LLMCredential[]
}

export const llmApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listLLMProviders: builder.query<{ providers: LLMProvider[] }, void>({
      query: () => '/llm/providers',
      providesTags: ['LLMProviders'],
    }),
    getLLMConfig: builder.query<LLMConfigResponse, void>({
      query: () => '/llm/credentials',
      providesTags: ['LLMCredentials'],
    }),
    saveLLMCredential: builder.mutation<
      { ok: boolean; message: string; credential: LLMCredential },
      { provider: string; model: string; api_key: string; activate?: boolean }
    >({
      query: (body) => ({ url: '/llm/credentials', method: 'POST', body }),
      invalidatesTags: ['LLMCredentials'],
    }),
    activateLLMProvider: builder.mutation<{ ok: boolean }, string>({
      query: (provider) => ({
        url: `/llm/credentials/${provider}/activate`,
        method: 'POST',
      }),
      invalidatesTags: ['LLMCredentials'],
    }),
    deleteLLMCredential: builder.mutation<{ ok: boolean }, string>({
      query: (provider) => ({
        url: `/llm/credentials/${provider}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['LLMCredentials'],
    }),
  }),
})

export const {
  useListLLMProvidersQuery,
  useGetLLMConfigQuery,
  useSaveLLMCredentialMutation,
  useActivateLLMProviderMutation,
  useDeleteLLMCredentialMutation,
} = llmApi
