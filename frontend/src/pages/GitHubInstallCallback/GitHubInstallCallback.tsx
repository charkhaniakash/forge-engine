import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon, Spinner } from '@/components/common'
import { useLinkInstallationMutation } from '@/services/api/repositoryApi'
import { ROUTES } from '@/constants/routes'
import { cn } from '@/lib/utils'

type Phase = 'linking' | 'success' | 'error'

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const msg = (data as { error?: unknown }).error
      if (typeof msg === 'string') return msg
    }
  }
  return 'We could not link your GitHub installation. Please try again.'
}

export function GitHubInstallCallback() {
  const [searchParams] = useSearchParams()
  const [linkInstallation] = useLinkInstallationMutation()
  const [phase, setPhase] = useState<Phase>('linking')
  const [message, setMessage] = useState('Please wait while we link your GitHub App installation…')
  const started = useRef(false)

  const installationId = searchParams.get('installation_id')
  const setupAction = searchParams.get('setup_action')

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (started.current) return
    started.current = true

    if (!installationId) {
      setPhase('error')
      setMessage('Missing installation_id parameter in the callback URL.')
      return
    }

    if (setupAction === 'request') {
      setPhase('success')
      setMessage('Your installation request was submitted. An organization admin needs to approve it before repositories appear.')
      return
    }

    void (async () => {
      try {
        await linkInstallation({ installation_id: installationId }).unwrap()
        setPhase('success')
        setMessage('Your GitHub installation is linked. Your repositories will appear shortly.')
      } catch (err) {
        setPhase('error')
        setMessage(errorMessage(err))
      }
    })()
  }, [installationId, setupAction, linkInstallation])
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-4">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        {phase === 'linking' && (
          <>
            <Spinner size={28} />
            <h1 className="text-lg font-semibold text-fg">Linking installation</h1>
            <p className="text-[13px] leading-relaxed text-fg-muted">{message}</p>
          </>
        )}

        {phase === 'success' && (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
              <Icon name="check" size={24} />
            </div>
            <h1 className="text-lg font-semibold text-fg">Installation linked</h1>
            <p className="text-[13px] leading-relaxed text-fg-muted">{message}</p>
            <Link
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground no-underline transition-all hover:no-underline hover:brightness-110"
              to={ROUTES.repositories}
            >
              <Icon name="repo" size={14} /> View repositories
            </Link>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Icon name="alert" size={24} />
            </div>
            <h1 className="text-lg font-semibold text-fg">Installation failed</h1>
            <p className="text-[13px] leading-relaxed text-fg-muted">{message}</p>
            <Link
              className={cn('mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-[13px] font-medium text-fg-muted no-underline transition-colors hover:bg-surface-2 hover:no-underline')}
              to={ROUTES.repositories}
            >
              Back to repositories
            </Link>
          </>
        )}
      </div>
    </div>
  )
}

export default GitHubInstallCallback
