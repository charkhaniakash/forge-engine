import { Suspense } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { MissionSidebar } from './MissionSidebar'
import { ErrorBoundary } from '@/components/common/ErrorBoundary/ErrorBoundary'
import { Spinner } from '@/components/common'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants/routes'

/**
 * Authenticated shell: a single persistent Mission rail + the active surface.
 * No top nav, no CRUD navigation — the rail is New Mission + recent missions.
 */
export function AppLayout() {
  const { isAuthenticated } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to={ROUTES.login} replace state={{ from: location.pathname }} />
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <MissionSidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-base">
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-fg-subtle">
                <Spinner size={22} />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}
