import { useState, useEffect } from 'react'
import './App.css'

interface AuthState {
  token: string | null
  user: any
  org: any
  role: string | null
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    user: null,
    org: null,
    role: null,
  })
  const [screen, setScreen] = useState<'home' | 'signup' | 'login' | 'dashboard'>('home')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Signup
  const handleSignup = async (email: string, password: string, name: string) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('http://localhost:8080/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Signup failed')
        return
      }
      alert('Signup successful! Please login.')
      setScreen('login')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Login
  const handleLogin = async (email: string, password: string) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('http://localhost:8080/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error || 'Login failed')
        return
      }
      setAuthState({
        token: data.token,
        user: data.user,
        org: data.org,
        role: data.role,
      })
      setScreen('dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Logout
  const handleLogout = () => {
    setAuthState({ token: null, user: null, org: null, role: null })
    setScreen('home')
  }

  if (screen === 'signup') {
    return <SignupForm onSubmit={handleSignup} onCancel={() => setScreen('home')} loading={loading} error={error} />
  }

  if (screen === 'login') {
    return <LoginForm onSubmit={handleLogin} onCancel={() => setScreen('home')} loading={loading} error={error} />
  }

  if (screen === 'dashboard' && authState.token) {
    return <Dashboard user={authState.user} org={authState.org} role={authState.role} token={authState.token} onLogout={handleLogout} />
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '600px', margin: '0 auto' }}>
      <h1>🔧 Forge Engine</h1>
      <p>Autonomous Software Engineering Agent Platform</p>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <button onClick={() => setScreen('signup')}>Sign Up</button>
        <button onClick={() => setScreen('login')}>Log In</button>
      </div>
    </div>
  )
}

function SignupForm({ onSubmit, onCancel, loading, error }: any) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '400px', margin: '0 auto' }}>
      <h2>Sign Up</h2>
      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ display: 'block', marginBottom: '0.5rem', width: '100%', padding: '0.5rem' }}
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ display: 'block', marginBottom: '0.5rem', width: '100%', padding: '0.5rem' }}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ display: 'block', marginBottom: '1rem', width: '100%', padding: '0.5rem' }}
      />
      <button onClick={() => onSubmit(email, password, name)} disabled={loading} style={{ marginRight: '0.5rem' }}>
        {loading ? 'Signing up...' : 'Sign Up'}
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  )
}

function LoginForm({ onSubmit, onCancel, loading, error }: any) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '400px', margin: '0 auto' }}>
      <h2>Log In</h2>
      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ display: 'block', marginBottom: '0.5rem', width: '100%', padding: '0.5rem' }}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ display: 'block', marginBottom: '1rem', width: '100%', padding: '0.5rem' }}
      />
      <button onClick={() => onSubmit(email, password)} disabled={loading} style={{ marginRight: '0.5rem' }}>
        {loading ? 'Logging in...' : 'Log In'}
      </button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  )
}

function Dashboard({ user, org, role, token, onLogout }: any) {
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h2>Dashboard</h2>
      <div style={{ marginBottom: '2rem', padding: '1rem', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
        <p><strong>User:</strong> {user.name} ({user.email})</p>
        <p><strong>Organization:</strong> {org.name}</p>
        <p><strong>Role:</strong> {role}</p>
      </div>
      <div>
        <button onClick={onLogout} style={{ backgroundColor: '#e74c3c', color: 'white' }}>Log Out</button>
      </div>
    </div>
  )
}