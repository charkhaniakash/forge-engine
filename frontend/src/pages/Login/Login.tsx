import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/common'
import { useLoginMutation } from '@/services/api/authApi'
import { ROUTES } from '@/constants/routes'
import styles from './Login.module.css'

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const msg = (data as { error?: unknown }).error
      if (typeof msg === 'string') return msg
    }
  }
  return 'Unable to sign in. Please check your credentials and try again.'
}

export function Login() {
  const navigate = useNavigate()
  const [login, { isLoading, error }] = useLoginMutation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    try {
      await login({ email, password }).unwrap()
      navigate(ROUTES.dashboard)
    } catch {
      // Error surfaced via the `error` state below.
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h1 className={styles.heading}>Sign in</h1>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className={styles.input}
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && <div className={styles.error}>{errorMessage(error)}</div>}

      <Button type="submit" variant="primary" block loading={isLoading}>
        Sign in
      </Button>

      <p className={styles.footer}>
        Don&apos;t have an account?{' '}
        <Link className={styles.link} to={ROUTES.signup}>
          Sign up
        </Link>
      </p>
    </form>
  )
}

export default Login
