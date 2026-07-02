/**
 * ExecutionPanel — Phase 7 live execution UI.
 *
 * Shows for tasks in plan_approved / executing / done / failed status.
 * Lets the user start execution, watch the live timeline, inspect diffs,
 * and cancel a running execution.
 */
import { useEffect, useRef, useState } from 'react'

const API = 'http://localhost:8080'

interface StepExecution {
  id: string
  step_stable_id: string
  step_order: number
  status: string             // pending|running|completed|failed|skipped|deviated
  reasoning?: string
  deviation_note?: string
  started_at?: string
  completed_at?: string
}

interface TaskExecution {
  id: string
  work_item_id: string
  workspace_id: string
  status: string             // pending|running|completed|failed|cancelled
  current_step_stable_id?: string
  started_at?: string
  completed_at?: string
  error?: string
}

interface CodeDiff {
  id: string
  file_path: string
  operation: string          // modify|create|delete|rename
  old_path?: string
  diff_unified?: string
  lines_added: number
  lines_removed: number
}

interface ExecutionEvent {
  id: string
  seq: number
  event_type: string
  tool_name?: string
  message?: string
}

interface ExecutionPanelProps {
  repoID: string
  taskID: string
  token: string
  taskStatus: string
  approvalStatus: string
}

const STEP_COLOR: Record<string, string> = {
  pending:   '#57606a',
  running:   '#0969da',
  completed: '#1a7f37',
  failed:    '#cf222e',
  deviated:  '#bf8700',
  skipped:   '#57606a',
}

const LIVE_STATUSES = new Set(['pending', 'running'])

export function ExecutionPanel({ repoID, taskID, token, taskStatus, approvalStatus }: ExecutionPanelProps) {
  const [execution, setExecution] = useState<TaskExecution | null>(null)
  const [steps, setSteps] = useState<StepExecution[]>([])
  const [diffs, setDiffs] = useState<CodeDiff[]>([])
  const [liveEvents, setLiveEvents] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logsEndRef = useRef<HTMLDivElement | null>(null)

  const authHeader = { Authorization: `Bearer ${token}` }
  const base = `${API}/v1/repos/${repoID}/tasks/${taskID}/execution`

  useEffect(() => {
    fetchExecution()
    return () => { wsRef.current?.close(); if (pollRef.current) clearInterval(pollRef.current) }
  }, [taskID])

  // Poll while execution is live.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (execution && LIVE_STATUSES.has(execution.status)) {
      pollRef.current = setInterval(fetchExecution, 2000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [execution?.status])

  // WebSocket for live events.
  useEffect(() => {
    wsRef.current?.close()
    if (!execution || !LIVE_STATUSES.has(execution.status)) return
    const ws = new WebSocket(
      `ws://localhost:8080/v1/repos/${repoID}/tasks/${taskID}/execution/stream?token=${encodeURIComponent(token)}`
    )
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        const label = formatLiveEvent(ev)
        if (label) setLiveEvents(prev => [...prev.slice(-99), label])
        // Refresh on terminal events.
        if (['step_complete', 'exec_complete', 'error', 'deviation'].includes(ev.event)) {
          fetchExecution()
        }
      } catch (_) {}
    }
    wsRef.current = ws
    return () => ws.close()
  }, [execution?.id, execution?.status])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveEvents])

  const fetchExecution = async () => {
    try {
      const res = await fetch(base, { headers: authHeader })
      if (res.status === 404) return
      if (res.ok) {
        const data = await res.json()
        setExecution(data.execution)
        setSteps(data.steps ?? [])
        if (!LIVE_STATUSES.has(data.execution?.status)) fetchDiffs()
      }
    } catch (_) {}
  }

  const fetchDiffs = async () => {
    try {
      const res = await fetch(`${base}/diffs`, { headers: authHeader })
      if (res.ok) setDiffs((await res.json()).diffs ?? [])
    } catch (_) {}
  }

  const startExecution = async () => {
    setStarting(true); setError(null); setLiveEvents([])
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/tasks/${taskID}/execute`, {
        method: 'POST', headers: authHeader,
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to start execution'); return }
      setExecution(data)
    } finally { setStarting(false) }
  }

  const cancelExecution = async () => {
    const res = await fetch(`${base}/cancel`, { method: 'POST', headers: authHeader })
    if (res.ok) fetchExecution()
  }

  const canStart = approvalStatus === 'approved' &&
    taskStatus === 'plan_approved' &&
    !execution

  const S = { fontFamily: 'sans-serif', fontSize: '13px' }

  return (
    <div style={{ marginTop: '16px', border: '1px solid #d0d7de', borderRadius: '6px', overflow: 'hidden', ...S }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', background: '#f6f8fa', borderBottom: '1px solid #d0d7de', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>🚀 Execution</strong>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {execution && (
            <span style={{ fontSize: '12px', fontWeight: 600, color: STEP_COLOR[execution.status] ?? '#57606a' }}>
              {execution.status}
            </span>
          )}
          {execution?.status === 'running' && (
            <button onClick={cancelExecution} style={{ fontSize: '12px', padding: '2px 8px', color: '#cf222e' }}>
              Cancel
            </button>
          )}
          {canStart && (
            <button onClick={startExecution} disabled={starting}
              style={{ fontSize: '12px', padding: '3px 10px', background: '#0969da', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              {starting ? 'Starting…' : '▶ Start execution'}
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ padding: '8px 14px', color: '#cf222e', background: '#ffebe9', borderBottom: '1px solid #d0d7de' }}>{error}</div>}

      <div style={{ display: 'flex', minHeight: '200px' }}>
        {/* Step timeline */}
        <div style={{ width: '260px', borderRight: '1px solid #d0d7de', overflowY: 'auto' }}>
          {steps.length === 0 && (
            <div style={{ padding: '12px', color: '#57606a' }}>
              {execution ? 'Preparing steps…' : 'Start execution to see steps.'}
            </div>
          )}
          {steps.map(step => (
            <div key={step.id}
              onClick={() => setExpandedStep(expandedStep === step.id ? null : step.id)}
              style={{ padding: '8px 10px', borderBottom: '1px solid #e1e4e8', cursor: 'pointer',
                background: expandedStep === step.id ? '#f0f6ff' : execution?.current_step_stable_id === step.step_stable_id ? '#fef9c3' : 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#57606a' }}>#{step.step_order}</span>
                <span style={{ fontSize: '11px', color: STEP_COLOR[step.status] ?? '#57606a', fontWeight: 600 }}>{step.status}</span>
              </div>
              <div style={{ fontSize: '12px', marginTop: '2px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {step.step_stable_id}
              </div>
              {expandedStep === step.id && step.reasoning && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: '#57606a', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {step.reasoning}
                </div>
              )}
              {expandedStep === step.id && step.deviation_note && (
                <div style={{ marginTop: '4px', fontSize: '11px', color: '#bf8700', padding: '4px', background: '#fffbdd', borderRadius: '3px' }}>
                  ⚠ Deviation: {step.deviation_note}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Right panel: live events + diffs */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Live event log */}
          {(LIVE_STATUSES.has(execution?.status ?? '') || liveEvents.length > 0) && (
            <div style={{ borderBottom: '1px solid #d0d7de', background: '#0d1117', padding: '8px 12px', maxHeight: '140px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '11px' }}>
              {liveEvents.map((msg, i) => (
                <div key={i} style={{ color: '#c9d1d9', marginBottom: '2px' }}>{msg}</div>
              ))}
              {execution?.status === 'running' && (
                <div style={{ color: '#58a6ff' }}>● Running…</div>
              )}
              <div ref={logsEndRef} />
            </div>
          )}

          {/* Diffs */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
            {diffs.length === 0 && execution?.status === 'completed' && (
              <div style={{ color: '#57606a' }}>No file changes recorded.</div>
            )}
            {diffs.map(diff => (
              <div key={diff.id} style={{ marginBottom: '10px', border: '1px solid #d0d7de', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  onClick={() => setExpandedDiff(expandedDiff === diff.id ? null : diff.id)}
                  style={{ padding: '6px 10px', background: '#f6f8fa', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span>
                    <OperationBadge op={diff.operation} />
                    <code style={{ marginLeft: '6px' }}>{diff.file_path}</code>
                  </span>
                  <span style={{ color: '#57606a' }}>
                    {diff.lines_added > 0 && <span style={{ color: '#1a7f37' }}>+{diff.lines_added} </span>}
                    {diff.lines_removed > 0 && <span style={{ color: '#cf222e' }}>-{diff.lines_removed}</span>}
                  </span>
                </div>
                {expandedDiff === diff.id && diff.diff_unified && (
                  <pre style={{ margin: 0, padding: '8px', fontSize: '11px', background: '#0d1117', color: '#c9d1d9', overflowX: 'auto', maxHeight: '300px', whiteSpace: 'pre' }}>
                    {coloriseDiff(diff.diff_unified)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function OperationBadge({ op }: { op: string }) {
  const colors: Record<string, string> = {
    modify: '#0969da', create: '#1a7f37', delete: '#cf222e', rename: '#bf8700',
  }
  return (
    <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '10px',
      background: colors[op] ?? '#57606a', color: '#fff' }}>
      {op}
    </span>
  )
}

function coloriseDiff(unified: string): React.ReactNode {
  return unified.split('\n').map((line, i) => {
    const color = line.startsWith('+') && !line.startsWith('+++') ? '#3fb950'
      : line.startsWith('-') && !line.startsWith('---') ? '#f85149'
      : line.startsWith('@@') ? '#79c0ff'
      : '#c9d1d9'
    return <span key={i} style={{ color, display: 'block' }}>{line + '\n'}</span>
  })
}

function formatLiveEvent(ev: any): string {
  switch (ev.event) {
    case 'reasoning':    return `💭 ${ev.message?.slice(0, 80) ?? ''}`
    case 'tool_call':    return `🔧 ${ev.tool}(${JSON.stringify(ev.args ?? {}).slice(0, 60)})`
    case 'tool_result':  return `  ${ev.success ? '✓' : '✗'} ${ev.tool}`
    case 'deviation':    return `⚠ deviation: ${ev.message?.slice(0, 80) ?? ''}`
    case 'step_complete':return `✅ step complete: ${ev.summary?.slice(0, 60) ?? ''}`
    case 'exec_complete':return `🎉 execution complete`
    case 'error':        return `❌ error: ${ev.message?.slice(0, 80) ?? ''}`
    default:             return ''
  }
}
