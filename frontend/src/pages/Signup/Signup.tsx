import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/common'
import { useSignupMutation } from '@/services/api/authApi'
import { useToast } from '@/hooks/useToast'
import { ROUTES } from '@/constants/routes'
import styles from './Signup.module.css'

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const msg = (data as { error?: unknown }).error
      if (typeof msg === 'string') return msg
    }
  }
  return 'Unable to create your account. Please try again.'
}

export function Signup() {
  const navigate = useNavigate()
  const toast = useToast()
  const [signup, { isLoading, error }] = useSignupMutation()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    try {
      await signup({ name, email, password }).unwrap()
      toast.success('Account created', {
        message: 'You can now sign in with your credentials.',
      })
      navigate(ROUTES.login)
    } catch {
      // Error surfaced via the `error` state below.
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h1 className={styles.heading}>Create your account</h1>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="name">
          Name
        </label>
        <input
          id="name"
          className={styles.input}
          type="text"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

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
          autoComplete="new-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && <div className={styles.error}>{errorMessage(error)}</div>}

      <Button type="submit" variant="primary" block loading={isLoading}>
        Create account
      </Button>

      <p className={styles.footer}>
        Already have an account?{' '}
        <Link className={styles.link} to={ROUTES.login}>
          Sign in
        </Link>
      </p>
    </form>
  )
}

export default Signup
