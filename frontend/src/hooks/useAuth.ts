import { useAppSelector } from '@/app/hooks'

/** Convenience selector for the current auth session. */
export function useAuth() {
  const auth = useAppSelector((s) => s.auth)
  return {
    token: auth.token,
    user: auth.user,
    org: auth.org,
    role: auth.role,
    isAuthenticated: Boolean(auth.token),
  }
}
