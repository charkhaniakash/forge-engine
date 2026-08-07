import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/common'
import { useSignupMutation } from '@/services/api/authApi'
import { useToast } from '@/hooks/useToast'
import { ROUTES } from '@/constants/routes'

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
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <h1 className="text-xl font-semibold text-fg">Create your account</h1>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

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
          autoComplete="new-password"
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
        {isLoading ? <Spinner size={14} /> : 'Create account'}
      </Button>

      <p className="text-center text-[13px] text-fg-subtle">
        Already have an account?{' '}
        <Link className="font-medium text-primary hover:underline" to={ROUTES.login}>
          Sign in
        </Link>
      </p>
    </form>
  )
}

export default Signup
