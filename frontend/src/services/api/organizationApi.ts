import { baseApi } from './baseApi'
import type { OrgMember, Organization, Role } from '@/types'

export const organizationApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    listOrgs: builder.query<Organization[], void>({
      query: () => '/orgs',
      providesTags: [{ type: 'Org', id: 'LIST' }],
    }),

    getOrg: builder.query<Organization, string>({
      query: (orgId) => `/orgs/${orgId}`,
      providesTags: (_r, _e, orgId) => [{ type: 'Org', id: orgId }],
    }),

    createOrg: builder.mutation<Organization, { name: string }>({
      query: (body) => ({ url: '/orgs', method: 'POST', body }),
      invalidatesTags: [{ type: 'Org', id: 'LIST' }],
    }),

    listMembers: builder.query<OrgMember[], string>({
      query: (orgId) => `/orgs/${orgId}/members`,
      providesTags: (_r, _e, orgId) => [{ type: 'OrgMember', id: orgId }],
    }),

    inviteMember: builder.mutation<
      { message?: string },
      { orgId: string; email: string; role: Role }
    >({
      query: ({ orgId, ...body }) => ({
        url: `/orgs/${orgId}/members/invite`,
        method: 'POST',
        body,
      }),
      invalidatesTags: (_r, _e, { orgId }) => [{ type: 'OrgMember', id: orgId }],
    }),
  }),
})

export const {
  useListOrgsQuery,
  useGetOrgQuery,
  useCreateOrgMutation,
  useListMembersQuery,
  useInviteMemberMutation,
} = organizationApi
