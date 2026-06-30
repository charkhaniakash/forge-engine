/**
 * TaskPanel — Phase 5 task creation & planning UI.
 *
 * Shows for any indexed repo. Lets the user describe an engineering task,
 * watches live planning progress via WebSocket, then displays the plan for
 * review, editing, and approval.
 */
import { useEffect, useRef, useState } from 'react'

const API = 'http://localhost:8080'

interface PlanStep {
  id: string
  stable_id: string
  order: number
  depends_on: string[]
  title: string
  description: string
  type: 'edit' | 'test' | 'verify' | 'manual'
  affected_files: string[]
  estimated_risk: 'low' | 'medium' | 'high'
  user_edited: boolean
  metadata: Record<string, unknown>
}

interface PlanBody {
  schema_version: string
  plan_type: string
  intent_summary: string
  risks: { severity: string; description: string }[]
  assumptions: { description: string; user_verified: boolean }[]
  affected_files: { path: string; change_type: string; rationale: string }[]
  steps: PlanStep[]
}

interface Plan {
  id: string
  work_item_id: string
  version: number
  plan_type: string
  planner_id: string
  body: PlanBody
  is_active: boolean
  created_by: string
  created_at: string
}

interface WorkItem {
  id: string
  repo_id: string
  intent: string
  status: string
  approval_status: string
  error?: string
  created_at: string
}

interface TaskPanelProps {
  repoID: string
  repoName: string
  token: string
}

const RISK_COLOR: Record<string, string> = {
  low: '#1a7f37', medium: '#bf8700', high: '#cf222e',
}

const STATUS_COLOR: Record<string, string> = {
  draft: '#57606a', planning: '#0969da', planning_failed: '#cf222e',
  plan_ready: '#bf8700', plan_approved: '#1a7f37',
  executing: '#0969da', done: '#1a7f37', failed: '#cf222e', cancelled: '#57606a',
}

export function TaskPanel({ repoID, repoName, token }: TaskPanelProps) {
  const [tasks, setTasks] = useState<WorkItem[]>([])
  const [activeTask, setActiveTask] = useState<WorkItem | null>(null)
  const [activePlan, setActivePlan] = useState<Plan | null>(null)
  const [intent, setIntent] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thinkingMessages, setThinkingMessages] = useState<string[]>([])
  const [editingSteps, setEditingSteps] = useState<PlanStep[] | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => { loadTasks() }, [repoID])

  useEffect(() => {
    wsRef.current?.close()
    if (!activeTask || !['planning'].includes(activeTask.status)) return
    const ws = new WebSocket(
      `ws://localhost:8080/v1/repos/${repoID}/tasks/${activeTask.id}/stream?token=${encodeURIComponent(token)}`
    )
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        if (ev.event === 'thinking') {
          setThinkingMessages(prev => [...prev, `[${ev.stage}] ${ev.message}`])
        } else if (ev.event === 'plan') {
          pollTask(activeTask.id)
        } else if (ev.event === 'error') {
          setError(ev.message)
          pollTask(activeTask.id)
        }
      } catch (_) {}
    }
    wsRef.current = ws
    return () => ws.close()
  }, [activeTask?.id, activeTask?.status])

  const loadTasks = async () => {
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) setTasks(data.tasks ?? [])
    } catch (_) {}
  }

  const pollTask = async (taskID: string) => {
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/tasks/${taskID}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) {
        setActiveTask(data.task)
        setActivePlan(data.plan ?? null)
        setTasks(prev => prev.map(t => t.id === taskID ? data.task : t))
      }
    } catch (_) {}
  }

  const createTask = async () => {
    if (!intent.trim() || creating) return
    setCreating(true); setError(null); setThinkingMessages([])
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: intent.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to create task'); return }
      setTasks(prev => [data, ...prev])
      setActiveTask(data)
      setActivePlan(null)
      setIntent('')
    } finally { setCreating(false) }
  }

  const approveTask = async () => {
    if (!activeTask) return
    setError(null)
    const res = await fetch(`${API}/v1/repos/${repoID}/tasks/${activeTask.id}/approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error ?? 'Approval failed'); return }
    setActiveTask(data.task)
    setTasks(prev => prev.map(t => t.id === data.task.id ? data.task : t))
  }

  const replanTask = async () => {
    if (!activeTask) return
    setError(null); setThinkingMessages([])
    const res = await fetch(`${API}/v1/repos/${repoID}/tasks/${activeTask.id}/replan`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error ?? 'Replan failed'); return }
    setActiveTask(data.task)
    setActivePlan(null)
    setTasks(prev => prev.map(t => t.id === data.task.id ? data.task : t))
  }

  const submitEditedPlan = async () => {
    if (!activeTask || !editingSteps || !activePlan) return
    const newBody = { ...activePlan.body, steps: editingSteps }
    const res = await fetch(`${API}/v1/repos/${repoID}/tasks/${activeTask.id}/plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: newBody }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error ?? 'Failed to save plan'); return }
    setActivePlan(data.plan)
    setEditingSteps(null)
    pollTask(activeTask.id)
  }

  const openTask = async (task: WorkItem) => {
    setActiveTask(task); setActivePlan(null); setEditingSteps(null); setError(null); setThinkingMessages([])
    await pollTask(task.id)
  }

  const S = { fontFamily: 'sans-serif', fontSize: '14px' }

  return (
    <div style={{ display: 'flex', height: '600px', border: '1px solid #d0d7de', borderRadius: '6px', overflow: 'hidden', ...S }}>
      {/* Task list */}
      <div style={{ width: '240px', borderRight: '1px solid #d0d7de', display: 'flex', flexDirection: 'column', background: '#f6f8fa' }}>
        <div style={{ padding: '10px', borderBottom: '1px solid #d0d7de', fontWeight: 600 }}>Tasks — {repoName}</div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tasks.map(t => (
            <button key={t.id} onClick={() => openTask(t)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none',
                background: activeTask?.id === t.id ? '#dbeafe' : 'transparent',
                cursor: 'pointer', borderBottom: '1px solid #e1e4e8', fontSize: '13px' }}>
              <div style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontWeight: 500 }}>
                {t.intent.slice(0, 50)}{t.intent.length > 50 ? '…' : ''}
              </div>
              <span style={{ fontSize: '11px', color: STATUS_COLOR[t.status] ?? '#57606a' }}>{t.status}</span>
            </button>
          ))}
        </div>
        {/* New task input */}
        <div style={{ padding: '8px', borderTop: '1px solid #d0d7de' }}>
          <textarea value={intent} onChange={e => setIntent(e.target.value)}
            placeholder="Describe a task…" rows={3}
            style={{ width: '100%', fontSize: '13px', padding: '6px', resize: 'none', border: '1px solid #d0d7de', borderRadius: '4px', boxSizing: 'border-box' }} />
          <button onClick={createTask} disabled={creating || !intent.trim()}
            style={{ width: '100%', marginTop: '4px', padding: '6px', background: '#0969da', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>
            {creating ? 'Planning…' : '+ Create task'}
          </button>
        </div>
      </div>

      {/* Detail pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeTask ? (
          <div style={{ padding: '40px', color: '#57606a', textAlign: 'center' }}>Select or create a task.</div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #d0d7de', background: '#f6f8fa', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ marginRight: '8px' }}>{activeTask.intent.slice(0, 80)}</strong>
                <span style={{ fontSize: '12px', color: STATUS_COLOR[activeTask.status] ?? '#57606a' }}>
                  {activeTask.status}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                {(activeTask.status === 'plan_ready' || activeTask.status === 'planning_failed') && (
                  <button onClick={replanTask} style={{ fontSize: '12px', padding: '3px 8px' }}>↺ Replan</button>
                )}
                {activeTask.status === 'plan_ready' && (
                  <button onClick={approveTask}
                    style={{ fontSize: '12px', padding: '3px 8px', background: '#1a7f37', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                    ✓ Approve
                  </button>
                )}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
              {error && <div style={{ color: '#cf222e', marginBottom: '12px', padding: '8px', background: '#ffebe9', borderRadius: '4px' }}>{error}</div>}

              {/* Planning progress */}
              {activeTask.status === 'planning' && thinkingMessages.length > 0 && (
                <div style={{ marginBottom: '16px', padding: '10px', background: '#dbeafe', borderRadius: '4px' }}>
                  <strong style={{ fontSize: '13px', color: '#0969da' }}>Planning in progress…</strong>
                  {thinkingMessages.slice(-5).map((m, i) => (
                    <div key={i} style={{ fontSize: '12px', color: '#1d4ed8', marginTop: '4px' }}>{m}</div>
                  ))}
                </div>
              )}

              {/* Plan display */}
              {activePlan && <PlanView plan={activePlan} editing={editingSteps}
                onStartEdit={() => setEditingSteps([...activePlan.body.steps])}
                onStepChange={(i, desc) => setEditingSteps(prev => prev ? prev.map((s, idx) => idx === i ? { ...s, description: desc, user_edited: true } : s) : prev)}
                onDeleteStep={(i) => setEditingSteps(prev => prev ? prev.filter((_, idx) => idx !== i) : prev)}
                onMoveStep={(i, dir) => setEditingSteps(prev => { if (!prev) return prev; const a = [...prev]; const j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; })}
                onSaveEdit={submitEditedPlan}
                onCancelEdit={() => setEditingSteps(null)} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── PlanView ─────────────────────────────────────────────────────────────────

interface PlanViewProps {
  plan: Plan
  editing: PlanStep[] | null
  onStartEdit: () => void
  onStepChange: (i: number, desc: string) => void
  onDeleteStep: (i: number) => void
  onMoveStep: (i: number, dir: number) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
}

function PlanView({ plan, editing, onStartEdit, onStepChange, onDeleteStep, onMoveStep, onSaveEdit, onCancelEdit }: PlanViewProps) {
  const body = plan.body
  const steps = editing ?? body.steps

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <div>
          <strong>Plan v{plan.version}</strong>
          <span style={{ marginLeft: '8px', fontSize: '12px', color: '#57606a' }}>
            {plan.created_by === 'user_edit' ? '(user edited)' : `(${plan.planner_id})`}
          </span>
        </div>
        {!editing && (
          <button onClick={onStartEdit} style={{ fontSize: '12px', padding: '3px 8px' }}>✏ Edit plan</button>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={onSaveEdit} style={{ fontSize: '12px', padding: '3px 8px', background: '#0969da', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Save</button>
            <button onClick={onCancelEdit} style={{ fontSize: '12px', padding: '3px 8px' }}>Cancel</button>
          </div>
        )}
      </div>

      <p style={{ fontSize: '13px', color: '#57606a', marginBottom: '12px' }}>{body.intent_summary}</p>

      {body.risks.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>Risks</strong>
          {body.risks.map((r, i) => (
            <div key={i} style={{ fontSize: '12px', color: RISK_COLOR[r.severity] ?? '#57606a', marginTop: '3px' }}>
              [{r.severity}] {r.description}
            </div>
          ))}
        </div>
      )}

      {body.affected_files.length > 0 && (
        <div style={{ marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>Affected files</strong>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
            {body.affected_files.map((f, i) => (
              <span key={i} title={f.rationale}
                style={{ fontSize: '11px', padding: '2px 6px', background: '#f0f6ff', color: '#0550ae', borderRadius: '10px', border: '1px solid #cae0ff' }}>
                {f.change_type === 'create' ? '+ ' : f.change_type === 'delete' ? '− ' : '~ '}{f.path.split('/').pop()}
              </span>
            ))}
          </div>
        </div>
      )}

      <strong style={{ fontSize: '13px' }}>Steps ({steps.length})</strong>
      <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {steps.map((step, i) => (
          <div key={step.id} style={{ padding: '10px', border: '1px solid #d0d7de', borderRadius: '6px', background: step.user_edited ? '#fffbdd' : '#fff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '12px', color: '#57606a', marginRight: '6px' }}>#{step.order}</span>
                <strong style={{ fontSize: '13px' }}>{step.title}</strong>
                <span style={{ marginLeft: '6px', fontSize: '11px', color: RISK_COLOR[step.estimated_risk] ?? '#57606a' }}>
                  {step.estimated_risk} risk
                </span>
                {step.user_edited && <span style={{ marginLeft: '6px', fontSize: '11px', color: '#bf8700' }}>edited</span>}
              </div>
              {editing && (
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button onClick={() => onMoveStep(i, -1)} disabled={i === 0} style={{ fontSize: '11px', padding: '1px 5px' }}>↑</button>
                  <button onClick={() => onMoveStep(i, 1)} disabled={i === steps.length - 1} style={{ fontSize: '11px', padding: '1px 5px' }}>↓</button>
                  <button onClick={() => onDeleteStep(i)} style={{ fontSize: '11px', padding: '1px 5px', color: '#cf222e' }}>✕</button>
                </div>
              )}
            </div>
            {editing ? (
              <textarea value={step.description} onChange={e => onStepChange(i, e.target.value)}
                rows={3} style={{ width: '100%', marginTop: '6px', fontSize: '12px', padding: '4px', resize: 'vertical', border: '1px solid #d0d7de', borderRadius: '4px', boxSizing: 'border-box' }} />
            ) : (
              <p style={{ fontSize: '12px', color: '#57606a', marginTop: '4px', marginBottom: 0 }}>{step.description}</p>
            )}
            {step.affected_files.length > 0 && (
              <div style={{ marginTop: '4px', fontSize: '11px', color: '#0550ae' }}>
                {step.affected_files.join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
