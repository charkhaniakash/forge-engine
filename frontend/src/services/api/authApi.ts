import { baseApi } from './baseApi'
import { credentialsReceived } from '@/store/slices/authSlice'
import type { AuthSession, LoginRequest, SignupRequest } from '@/types'

export const authApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    signup: builder.mutation<{ message?: string }, SignupRequest>({
      query: (body) => ({ url: '/auth/signup', method: 'POST', body }),
    }),

    login: builder.mutation<AuthSession, LoginRequest>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        const { data } = await queryFulfilled
        dispatch(credentialsReceived(data))
      },
    }),
  }),
})

export const { useSignupMutation, useLoginMutation } = authApi
