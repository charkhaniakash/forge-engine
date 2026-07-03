import type { ID, ISODate } from './common'

export type Role = 'owner' | 'admin' | 'member'

export interface User {
  id: ID
  email: string
  name: string
  created_at?: ISODate
}

export interface Organization {
  id: ID
  name: string
  slug?: string
  created_at?: ISODate
}

export interface OrgMember {
  id: ID
  user_id: ID
  name: string
  email: string
  role: Role
  joined_at?: ISODate
}

export interface SignupRequest {
  email: string
  password: string
  name: string
}

export interface LoginRequest {
  email: string
  password: string
}

/** Shape returned by POST /v1/auth/login. */
export interface AuthSession {
  token: string
  user: User
  org: Organization
  role: Role
}
