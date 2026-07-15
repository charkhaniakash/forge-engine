import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react'
import { API_BASE_URL } from '@/constants/config'
import type { RootState } from '@/app/store'
import { sessionExpired } from '@/store/slices/authSlice'

/**
 * Single shared RTK Query API. Every domain service (`authApi`,
 * `repositoryApi`, …) is created with `baseApi.injectEndpoints`, so there is
 * one reducer + one middleware in the store while endpoints stay in feature
 * files. The bearer token is read from the auth slice on every request.
 */

const rawBaseQuery = fetchBaseQuery({
  baseUrl: API_BASE_URL,
  // Auth is header-only (Bearer JWT) — never send cookies on requests.
  credentials: 'omit',
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.token
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return headers
  },
})

const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions)
  // A 401 means the JWT is missing/expired — clear the session so the router
  // bounces the user to /login.
  if (result.error && result.error.status === 401) {
    api.dispatch(sessionExpired())
  }
  return result
}

export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: [
    'Repository',
    'IndexStatus',
    'QASession',
    'QAMessage',
    'Task',
    'Plan',
    'Execution',
    'Diff',
    'Workspace',
    'WorkspaceLog',
    'WsFiles',
    'WsGit',
    'Org',
    'OrgMember',
  ],
  endpoints: () => ({}),
})
