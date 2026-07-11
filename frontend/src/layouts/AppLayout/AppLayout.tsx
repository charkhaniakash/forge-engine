import { Suspense } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { MissionSidebar } from './MissionSidebar'
import { ErrorBoundary } from '@/components/common/ErrorBoundary/ErrorBoundary'
import { Spinner } from '@/components/common'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants/routes'
import styles from './AppLayout.module.css'

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
    <div className={styles.shell}>
      <MissionSidebar />
      <main className={styles.main}>
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className={styles.loading}>
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
