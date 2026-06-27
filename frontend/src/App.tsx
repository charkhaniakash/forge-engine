import { useState } from 'react'
import { GitHubInstallButton } from './components/GitHubInstallButton'
import { GitHubInstallCallback } from './pages/GitHubInstallCallback'
import './App.css'

interface AuthState {
  token: string | null
  user: any
  org: any
  role: string | null
}

interface GitHubRepo {
  id: string
  repo_name: string
  repo_full_name: string
  repo_owner: string
  default_branch: string
  private: boolean
  last_synced_at: string | null
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    user: null,
    org: null,
    role: null,
  })
  const [screen, setScreen] = useState<'home' | 'signup' | 'login' | 'dashboard' | 'callback'>('home')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Check if we're on the callback route
  const isCallback = window.location.pathname === '/github/install/callback'
  if (isCallback) {
    return <GitHubInstallCallback />
  }

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

interface IndexStatus {
  status: string
  job: {
    id: string
    status: string
    progress_stage: string | null
    processed_chunks: number
    total_chunks: number | null
    commit_sha: string
    error: string | null
  } | null
}

function IndexStatusBadge({ status }: { status?: IndexStatus }) {
  if (!status || status.status === 'not_indexed') {
    return <span style={{ fontSize: '12px', color: '#57606a' }}>Not indexed</span>
  }

  const job = status.job
  if (!job) {
    return <span style={{ fontSize: '12px', color: '#57606a' }}>Unknown</span>
  }

  const colors = {
    queued: '#bf8700',
    running: '#0969da',
    done: '#1a7f37',
    failed: '#cf222e',
    superseded: '#656d76',
  }

  return (
    <span style={{ fontSize: '12px', color: colors[job.status as keyof typeof colors] || '#57606a' }}>
      {job.status === 'running' && job.progress_stage ? `${job.progress_stage}...` : job.status}
    </span>
  )
}

function Dashboard({ user, org, role, token, onLogout }: any) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [githubError, setGithubError] = useState<string | null>(null)
  const [installationMissing, setInstallationMissing] = useState(false)
  const [indexStatuses, setIndexStatuses] = useState<Record<string, IndexStatus>>({})

  const loadRepos = async () => {
    setLoadingRepos(true)
    setGithubError(null)
    try {
      const response = await fetch('http://localhost:8080/v1/github/repos', {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await response.json()
      if (!response.ok) {
        setGithubError(data.error || 'Failed to load repos')
        return
      }
      setRepos(data)
      // Load index status for each repo
      data.forEach((repo: GitHubRepo) => loadIndexStatus(repo.id))
    } catch (err: any) {
      setGithubError(err.message)
    } finally {
      setLoadingRepos(false)
    }
  }

  const loadIndexStatus = async (repoID: string) => {
    try {
      const response = await fetch(`http://localhost:8080/v1/github/repos/${repoID}/index/status`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await response.json()
      if (response.ok) {
        setIndexStatuses(prev => ({ ...prev, [repoID]: data }))
      }
    } catch (_) {
      // non-fatal
    }
  }

  const triggerIndex = async (repoID: string) => {
    try {
      const response = await fetch(`http://localhost:8080/v1/github/repos/${repoID}/index/trigger`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await response.json()
      if (!response.ok) {
        setGithubError(data.error || 'Failed to trigger index')
        return
      }
      // Poll for status update
      setTimeout(() => loadIndexStatus(repoID), 1500)
    } catch (err: any) {
      setGithubError(err.message)
    }
  }

  const handleSyncRepos = async () => {
    setLoadingRepos(true)
    setGithubError(null)
    setInstallationMissing(false)
    try {
      const response = await fetch('http://localhost:8080/v1/github/sync', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await response.json()
      if (!response.ok) {
        if (response.status === 404) {
          // No installation found — show the recovery UI
          setInstallationMissing(true)
          setGithubError(data.error || 'No GitHub installation found')
        } else {
          setGithubError(data.error || 'Failed to sync repos')
        }
        return
      }
      setTimeout(loadRepos, 3000)
    } catch (err: any) {
      setGithubError(err.message)
    } finally {
      setLoadingRepos(false)
    }
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h2>Dashboard</h2>
      <div style={{ marginBottom: '2rem', padding: '1rem', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
        <p><strong>User:</strong> {user.name} ({user.email})</p>
        <p><strong>Organization:</strong> {org.name}</p>
        <p><strong>Role:</strong> {role}</p>
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <h3>GitHub Integration & Repository Indexing (Phase 3)</h3>

        {githubError && (
          <div style={{ color: '#cf222e', marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#ffebe9', borderRadius: '4px', border: '1px solid #ff818266' }}>
            {githubError}
          </div>
        )}

        {installationMissing && (
          <div style={{ marginBottom: '1rem', padding: '1rem', backgroundColor: '#fff8c5', borderRadius: '4px', border: '1px solid #d4a72c66' }}>
            <strong>GitHub App connection lost.</strong>
            <p style={{ margin: '0.5rem 0 0' }}>
              Your database was reset but the GitHub App is still installed. Click <strong>"Install GitHub App"</strong> below — GitHub will redirect back with your installation ID and the connection will be restored automatically. You will not need to reinstall.
            </p>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <GitHubInstallButton token={token} onError={(err) => setGithubError(err)} />
          <button onClick={loadRepos} disabled={loadingRepos}>
            Load Repos
          </button>
          <button onClick={handleSyncRepos} disabled={loadingRepos}>
            {loadingRepos ? 'Working…' : 'Sync Repos'}
          </button>
        </div>

        {loadingRepos && <p>Loading...</p>}

        {repos.length > 0 && (
          <div>
            <h4>Connected Repositories ({repos.length})</h4>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {repos.map((repo) => {
                const idxStatus = indexStatuses[repo.id]
                const job = idxStatus?.job
                return (
                  <li key={repo.id} style={{ padding: '0.75rem', borderBottom: '1px solid #ddd' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <strong>{repo.repo_full_name}</strong>
                        <br />
                        <small>Branch: {repo.default_branch} · {repo.private ? 'Private' : 'Public'}</small>
                        {repo.last_synced_at && (
                          <><br /><small>Synced: {new Date(repo.last_synced_at).toLocaleString()}</small></>
                        )}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <IndexStatusBadge status={idxStatus} />
                        <br />
                        <button
                          onClick={() => triggerIndex(repo.id)}
                          style={{ marginTop: '0.25rem', fontSize: '12px', padding: '2px 8px' }}
                        >
                          Index
                        </button>
                        {job?.status === 'running' && (
                          <button
                            onClick={() => loadIndexStatus(repo.id)}
                            style={{ marginTop: '0.25rem', marginLeft: '4px', fontSize: '12px', padding: '2px 8px' }}
                          >
                            ↻
                          </button>
                        )}
                      </div>
                    </div>
                    {job?.status === 'running' && job.total_chunks != null && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <div style={{ fontSize: '12px', color: '#57606a', marginBottom: '2px' }}>
                          {job.progress_stage ?? 'working'} · {job.processed_chunks}/{job.total_chunks} chunks
                        </div>
                        <div style={{ background: '#eee', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                          <div style={{
                            width: `${Math.round((job.processed_chunks / job.total_chunks) * 100)}%`,
                            background: '#0969da',
                            height: '100%',
                            transition: 'width 0.3s',
                          }} />
                        </div>
                      </div>
                    )}
                    {job?.status === 'failed' && job.error && (
                      <div style={{ marginTop: '0.25rem', fontSize: '12px', color: '#cf222e' }}>
                        Error: {job.error}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      <div>
        <button onClick={onLogout} style={{ backgroundColor: '#e74c3c', color: 'white' }}>Log Out</button>
      </div>
    </div>
  )
}