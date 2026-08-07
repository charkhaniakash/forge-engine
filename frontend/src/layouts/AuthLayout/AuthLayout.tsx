import { Navigate, Outlet } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/hooks/useAuth'
import { ROUTES } from '@/constants/routes'

/** Centered layout for login/signup. Redirects to the console if already authed. */
export function AuthLayout() {
  const { isAuthenticated } = useAuth()
  if (isAuthenticated) return <Navigate to={ROUTES.root} replace />

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base p-4">
      {/* Ambient glow — subtle brand atmosphere behind the card */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-fg-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--color-fg-subtle) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      <Card className="relative z-10 w-full max-w-sm gap-0 border-border bg-card/80 p-8 shadow-xl backdrop-blur">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-mono text-lg font-bold text-primary-foreground shadow-lg shadow-primary/20">
            F
          </span>
          <span className="text-lg font-semibold tracking-tight text-fg">Forge Engine</span>
        </div>
        <p className="mb-6 text-[13px] text-fg-subtle">Autonomous software engineering platform</p>
        <Outlet />
      </Card>
    </div>
  )
}
