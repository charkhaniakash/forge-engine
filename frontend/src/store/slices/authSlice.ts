import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { AuthSession, Organization, Role, User } from '@/types'
import { AUTH_TOKEN_KEY } from '@/constants/config'

interface AuthState {
  token: string | null
  user: User | null
  org: Organization | null
  role: Role | null
  /** True once we've read persisted state — gates the router's first render. */
  hydrated: boolean
}

/** Load any persisted session so a page refresh keeps the user logged in. */
function loadPersisted(): Pick<AuthState, 'token' | 'user' | 'org' | 'role'> {
  try {
    const raw = localStorage.getItem(AUTH_TOKEN_KEY)
    if (!raw) return { token: null, user: null, org: null, role: null }
    const parsed = JSON.parse(raw) as AuthSession
    return {
      token: parsed.token,
      user: parsed.user,
      org: parsed.org,
      role: parsed.role,
    }
  } catch {
    return { token: null, user: null, org: null, role: null }
  }
}

const initialState: AuthState = {
  ...loadPersisted(),
  hydrated: true,
}

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    credentialsReceived(state, action: PayloadAction<AuthSession>) {
      const { token, user, org, role } = action.payload
      state.token = token
      state.user = user
      state.org = org
      state.role = role
      localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify(action.payload))
    },
    activeOrgChanged(state, action: PayloadAction<Organization>) {
      state.org = action.payload
      if (state.token && state.user && state.role) {
        localStorage.setItem(
          AUTH_TOKEN_KEY,
          JSON.stringify({
            token: state.token,
            user: state.user,
            org: state.org,
            role: state.role,
          } satisfies AuthSession),
        )
      }
    },
    loggedOut(state) {
      state.token = null
      state.user = null
      state.org = null
      state.role = null
      localStorage.removeItem(AUTH_TOKEN_KEY)
    },
    /** Dispatched by the base query on a 401. */
    sessionExpired(state) {
      state.token = null
      state.user = null
      state.org = null
      state.role = null
      localStorage.removeItem(AUTH_TOKEN_KEY)
    },
  },
})

export const { credentialsReceived, activeOrgChanged, loggedOut, sessionExpired } =
  authSlice.actions
export default authSlice.reducer
