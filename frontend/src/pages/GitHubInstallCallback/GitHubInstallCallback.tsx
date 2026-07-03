import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon, Spinner } from '@/components/common'
import { useLinkInstallationMutation } from '@/services/api/repositoryApi'
import { ROUTES } from '@/constants/routes'
import styles from './GitHubInstallCallback.module.css'

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
  const [message, setMessage] = useState(
    'Please wait while we link your GitHub App installation…',
  )
  const started = useRef(false)

  const installationId = searchParams.get('installation_id')
  const setupAction = searchParams.get('setup_action')

  // One-time mount action: resolve the OAuth callback exactly once. The initial
  // phase/message writes are intentional synchronous state on mount.
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
      setMessage(
        'Your installation request was submitted. An organization admin needs to approve it before repositories appear.',
      )
      return
    }

    void (async () => {
      try {
        await linkInstallation({ installation_id: installationId }).unwrap()
        setPhase('success')
        setMessage(
          'Your GitHub installation is linked. Your repositories will appear shortly.',
        )
      } catch (err) {
        setPhase('error')
        setMessage(errorMessage(err))
      }
    })()
  }, [installationId, setupAction, linkInstallation])
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        {phase === 'linking' && (
          <>
            <Spinner size={28} />
            <h1 className={styles.title}>Linking installation</h1>
            <p className={styles.message}>{message}</p>
          </>
        )}

        {phase === 'success' && (
          <>
            <div className={`${styles.iconWrap} ${styles.iconSuccess}`}>
              <Icon name="check" size={24} />
            </div>
            <h1 className={styles.title}>Installation linked</h1>
            <p className={styles.message}>{message}</p>
            <Link
              className={`${styles.linkButton} ${styles.linkButtonPrimary}`}
              to={ROUTES.repositories}
            >
              <Icon name="repo" size={14} />
              View repositories
            </Link>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className={`${styles.iconWrap} ${styles.iconError}`}>
              <Icon name="alert" size={24} />
            </div>
            <h1 className={styles.title}>Installation failed</h1>
            <p className={styles.message}>{message}</p>
            <Link
              className={`${styles.linkButton} ${styles.linkButtonSecondary}`}
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
