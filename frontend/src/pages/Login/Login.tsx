import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/common'
import { useLoginMutation } from '@/services/api/authApi'
import { ROUTES } from '@/constants/routes'

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
      navigate(ROUTES.root)
    } catch {
      // Error surfaced via the `error` state below.
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <h1 className="text-xl font-semibold text-fg">Sign in</h1>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {errorMessage(error)}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? <Spinner size={14} /> : 'Sign in'}
      </Button>

      <p className="text-center text-[13px] text-fg-subtle">
        Don&apos;t have an account?{' '}
        <Link className="font-medium text-primary hover:underline" to={ROUTES.signup}>
          Sign up
        </Link>
      </p>
    </form>
  )
}

export default Login
