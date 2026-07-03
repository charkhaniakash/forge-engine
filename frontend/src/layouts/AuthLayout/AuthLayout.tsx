import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants/routes'
import styles from './AuthLayout.module.css'

/** Centered layout for login/signup. Redirects to dashboard if already authed. */
export function AuthLayout() {
  const { isAuthenticated } = useAuth()
  if (isAuthenticated) return <Navigate to={ROUTES.dashboard} replace />

  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span>
          <span>Forge Engine</span>
        </div>
        <p className={styles.tagline}>Autonomous software engineering platform</p>
        <Outlet />
      </div>
    </div>
  )
}
