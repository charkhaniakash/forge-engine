/**
 * WorkspaceStatus — Phase 6 sandbox lifecycle display.
 *
 * Shown inside TaskPanel for approved tasks. Lets the user:
 *   - Provision a new workspace (sandbox)
 *   - See the current workspace status in real time (auto-poll)
 *   - Browse the execution log (lifecycle events + commands)
 *   - Destroy the workspace manually
 *
 * The frontend never knows about Docker — it only talks to the Go backend.
 */
import { useEffect, useRef, useState } from 'react'

const API = 'http://localhost:8080'

const STATUS_COLOR: Record<string, string> = {
  provisioning: '#0969da',
  ready:        '#1a7f37',
  executing:    '#0969da',
  completed:    '#1a7f37',
  failed:       '#cf222e',
  timed_out:    '#cf222e',
  killed:       '#cf222e',
  destroying:   '#bf8700',
  destroyed:    '#57606a',
}

interface Workspace {
  id: string
  work_item_id: string
  repo_id: string
  commit_sha: string
  status: string
  container_name?: string
  image: string
  cpu_limit: string
  memory_limit_mb: number
  timeout_seconds: number
  started_at?: string
  ready_at?: string
  destroyed_at?: string
  error?: string
  created_at: string
}

interface ExecutionLog {
  id: string
  seq: number
  event_type: string             // 'lifecycle' | 'command'
  lifecycle_event?: string
  command?: string[]
  working_dir?: string
  exit_code?: number
  timed_out: boolean
  duration_ms?: number
  stdout?: string
  stderr?: string
  message?: string
  started_at?: string
  completed_at?: string
}

interface WorkspaceStatusProps {
  repoID: string
  taskID: string
  token: string
  approvalStatus: string         // only show provision button if 'approved'
}

// How often to re-poll when the workspace is in a transient state.
const POLL_INTERVAL_MS = 3000
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'killed', 'destroyed'])

export function WorkspaceStatus({ repoID, taskID, token, approvalStatus }: WorkspaceStatusProps) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [provisioning, setProvisioning] = useState(false)
  const [destroying, setDestroying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logsEndRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll execution logs.
  useEffect(() => {
    if (showLogs) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, showLogs])

  // Poll workspace status when in a transient state.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (workspace && !TERMINAL_STATUSES.has(workspace.status)) {
      pollRef.current = setInterval(() => {
        fetchWorkspace()
        if (showLogs) fetchLogs()
      }, POLL_INTERVAL_MS)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [workspace?.status, showLogs])

  // Load workspace on mount.
  useEffect(() => {
    fetchWorkspace()
  }, [taskID])

  const authHeader = { Authorization: `Bearer ${token}` }
  const wsBase = `${API}/v1/repos/${repoID}/tasks/${taskID}/workspace`

  const fetchWorkspace = async () => {
    try {
      const res = await fetch(wsBase, { headers: authHeader })
      if (res.status === 404) { setWorkspace(null); return }
      if (res.ok) setWorkspace(await res.json())
    } catch (_) {}
  }

  const fetchLogs = async () => {
    if (!workspace) return
    try {
      const res = await fetch(`${wsBase}/logs`, { headers: authHeader })
      if (res.ok) {
        const data = await res.json()
        setLogs(data.logs ?? [])
      }
    } catch (_) {}
  }

  const provision = async () => {
    setProvisioning(true); setError(null)
    try {
      const res = await fetch(wsBase, { method: 'POST', headers: authHeader })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to provision workspace'); return }
      setWorkspace(data)
    } finally {
      setProvisioning(false)
    }
  }

  const destroy = async () => {
    if (!workspace) return
    setDestroying(true); setError(null)
    try {
      const res = await fetch(wsBase, { method: 'DELETE', headers: authHeader })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to destroy workspace'); return }
      setWorkspace(prev => prev ? { ...prev, status: 'destroyed' } : null)
    } finally {
      setDestroying(false)
    }
  }

  const toggleLogs = async () => {
    if (!showLogs) await fetchLogs()
    setShowLogs(v => !v)
  }

  const S = { fontSize: '13px', fontFamily: 'sans-serif' }

  return (
    <div style={{ marginTop: '16px', border: '1px solid #d0d7de', borderRadius: '6px', overflow: 'hidden', ...S }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', background: '#f6f8fa', borderBottom: '1px solid #d0d7de', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>⚙️ Execution Workspace</strong>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {workspace && (
            <>
              <span style={{ fontSize: '12px', color: STATUS_COLOR[workspace.status] ?? '#57606a', fontWeight: 600 }}>
                {workspace.status}
              </span>
              <button onClick={toggleLogs} style={{ fontSize: '12px', padding: '2px 8px' }}>
                {showLogs ? 'Hide logs' : 'Logs'}
              </button>
              {!TERMINAL_STATUSES.has(workspace.status) && workspace.status !== 'provisioning' && (
                <button onClick={destroy} disabled={destroying}
                  style={{ fontSize: '12px', padding: '2px 8px', color: '#cf222e' }}>
                  {destroying ? '…' : 'Destroy'}
                </button>
              )}
            </>
          )}
          {!workspace && approvalStatus === 'approved' && (
            <button onClick={provision} disabled={provisioning}
              style={{ fontSize: '12px', padding: '3px 10px', background: '#1a7f37', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              {provisioning ? 'Provisioning…' : '▶ Provision workspace'}
            </button>
          )}
          {!workspace && approvalStatus !== 'approved' && (
            <span style={{ fontSize: '12px', color: '#57606a' }}>Approve the task to provision a workspace</span>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: '8px 14px', background: '#ffebe9', color: '#cf222e', borderBottom: '1px solid #d0d7de' }}>
          {error}
        </div>
      )}

      {/* Workspace details */}
      {workspace && (
        <div style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: '#57606a' }}>
            <span>Image: <strong>{workspace.image}</strong></span>
            <span>CPU: <strong>{workspace.cpu_limit}</strong></span>
            <span>RAM: <strong>{workspace.memory_limit_mb} MB</strong></span>
            <span>Commit: <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: '3px' }}>{workspace.commit_sha.slice(0, 8)}</code></span>
            {workspace.ready_at && (
              <span>Ready: {new Date(workspace.ready_at).toLocaleTimeString()}</span>
            )}
          </div>
          {workspace.error && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: '#cf222e' }}>{workspace.error}</div>
          )}
        </div>
      )}

      {/* Execution log */}
      {showLogs && workspace && (
        <div style={{ borderTop: '1px solid #d0d7de', maxHeight: '280px', overflowY: 'auto', background: '#0d1117', padding: '10px 14px', fontFamily: 'monospace', fontSize: '12px' }}>
          {logs.length === 0 && <div style={{ color: '#8b949e' }}>No log entries yet.</div>}
          {logs.map(log => <LogEntry key={log.id} log={log} />)}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  )
}

function LogEntry({ log }: { log: ExecutionLog }) {
  const isLifecycle = log.event_type === 'lifecycle'

  if (isLifecycle) {
    return (
      <div style={{ marginBottom: '4px' }}>
        <span style={{ color: '#8b949e' }}>[{log.seq}] </span>
        <span style={{ color: '#58a6ff' }}>● {log.lifecycle_event}</span>
        {log.message && <span style={{ color: '#c9d1d9' }}> — {log.message}</span>}
      </div>
    )
  }

  const exitOk = log.exit_code === 0
  return (
    <div style={{ marginBottom: '8px' }}>
      <div>
        <span style={{ color: '#8b949e' }}>[{log.seq}] </span>
        <span style={{ color: '#e3b341' }}>$ {(log.command ?? []).join(' ')}</span>
        {log.exit_code !== undefined && (
          <span style={{ marginLeft: '8px', color: exitOk ? '#3fb950' : '#f85149', fontSize: '11px' }}>
            exit {log.exit_code}{log.timed_out ? ' (timed out)' : ''}{log.duration_ms ? ` · ${log.duration_ms}ms` : ''}
          </span>
        )}
      </div>
      {log.stdout && <pre style={{ color: '#c9d1d9', margin: '2px 0 0 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log.stdout.slice(0, 2000)}</pre>}
      {log.stderr && <pre style={{ color: '#f85149', margin: '2px 0 0 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log.stderr.slice(0, 2000)}</pre>}
    </div>
  )
}
