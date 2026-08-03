import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, ConfirmDialog, EmptyState, Icon, Spinner, StatusBadge, ConnectionStatus } from '@/components/common'
import { MissionThread } from '@/features/task-workspace'
import { useOptimisticMutation } from '@/hooks/useOptimisticMutation'
import { AIActivityPanel } from '@/features/workspace/AIActivityPanel'
import { TaskStatusBar } from '@/features/workspace/TaskStatusBar'
import { LivePreview } from '@/features/workspace/LivePreview'
import { FileExplorer } from '@/features/workspace/FileExplorer'
import { MissionHero } from '@/features/task-workspace/MissionHero'
import { useRepairStream } from '@/features/task-workspace/useRepairStream'
import {
  buildConversation,
  buildFileChanges,
  buildRepairAttempts,
  buildValidationStages,
  type TurnArtifacts,
} from '@/features/task-workspace/normalize'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { taskStreamsReset, clearPublishingEvents, clearRepairEvents } from '@/store/slices/streamSlice'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useToast } from '@/hooks/useToast'
import {
  useApproveTaskMutation,
  useCancelTaskMutation,
  useFollowUpMutation,
  useGetTaskQuery,
  useListMissionMessagesQuery,
  useRefinePlanMutation,
  useReplanTaskMutation,
} from '@/services/api/taskApi'
// Execution cancel is superseded by the cross-phase collaborate/stop.
import {
  useGetExecutionDiffsQuery,
  useGetExecutionQuery,
  useStartExecutionMutation,
} from '@/services/api/executionApi'
import {
  useGetValidationQuery,
  useStartValidationMutation,
} from '@/services/api/validationApi'
import { useGetRepairSessionByTaskQuery } from '@/services/api/repairApi'
import { useStopExecutionMutation } from '@/services/api/workspaceEditorApi'
import {
  useGetWorkspaceQuery,
  useProvisionWorkspaceMutation,
} from '@/services/api/workspaceApi'
import {
  useGetPublishSessionQuery,
  useStartPublishMutation,
} from '@/services/api/publishingApi'
import { usePublishingStream } from '@/features/task-workspace/usePublishingStream'
import { loadPlanMode, savePlanMode } from '@/features/task-workspace/planMode'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './TaskWorkspace.module.css'

const EXEC_LIVE = new Set(['pending', 'running'])
const STORAGE_PREFIX = 'forge-turn-artifacts'

function loadStoredArtifacts(taskId: string): Record<number, TurnArtifacts> {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}-${taskId}`)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveStoredArtifacts(taskId: string, artifacts: Record<number, TurnArtifacts>) {
  try {
    const keys = Object.keys(artifacts).map(Number).sort((a, b) => a - b)
    const toKeep: Record<number, TurnArtifacts> = {}
    const pruneFrom = keys.length > 10 ? keys.length - 10 : 0
    for (let i = pruneFrom; i < keys.length; i++) toKeep[keys[i]] = artifacts[keys[i]]
    localStorage.setItem(`${STORAGE_PREFIX}-${taskId}`, JSON.stringify(toKeep))
  } catch { /* silently fail */ }
}

export function TaskWorkspace() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  // ── Data ────────────────────────────────────────────────────────────────
  // WebSocket events now drive all updates. Event-based refetch on terminal events
  // ensures fresh data without continuous polling overhead.
  const { data: taskData, isLoading, refetch: refetchTask } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const task = taskData?.task
  const plan = taskData?.plan

  const { data: execSnap, refetch: refetchExec } = useGetExecutionQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const execution = execSnap?.execution
  const taskExecutionId = execution?.id ?? ''
  const execLive = EXEC_LIVE.has(execution?.status ?? '')

  const { data: diffs = [], refetch: refetchDiffs } = useGetExecutionDiffsQuery(
    { repoId, taskId },
    { skip: !execution },
  )

  const { data: valSnap, refetch: refetchVal } = useGetValidationQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const valRun = valSnap?.run
  const valLiveState = valRun?.status === 'running' || valRun?.status === 'pending'

  const { data: repairSession, refetch: refetchRepair } = useGetRepairSessionByTaskQuery(taskExecutionId, {
    skip: !taskExecutionId,
  })

  const { data: workspace, refetch: refetchWorkspace } = useGetWorkspaceQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )

  // Phase 10 — publishing. Session id bootstraps the WebSocket; live progress
  // comes over usePublishingStream, not polling.
  const { data: publishData, refetch: refetchPublish } = useGetPublishSessionQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const publishSession = publishData?.session ?? null
  const publishTerminal =
    publishSession != null &&
    ['completed', 'failed', 'cancelled'].includes(publishSession.status)
  const publishActive = publishSession != null && !publishTerminal

  // Optimistic live state — set to true immediately when a follow-up is sent,
  // so the UI shows "Forge is thinking..." before the poll picks up the new
  // task status. Cleared once a real backend-detected phase is confirmed.
  const [pendingFollowUp, setPendingFollowUp] = useState(false)

  const isPlanning = task?.status === 'planning' || task?.status === 'draft' || task?.status === 'plan_ready' || pendingFollowUp
  const isPlanningLive = (task?.status === 'planning' || task?.status === 'draft') || pendingFollowUp

  // backendLive is true when REAL backend data confirms an active phase —
  // independent of the optimistic pendingFollowUp flag. This avoids the
  // circular dependency where live (via pendingFollowUp) would immediately
  // clear pendingFollowUp before the poll returns.
  const backendLive = (task?.status === 'planning' || task?.status === 'draft') ||
    execLive || valLiveState || repairSession?.status === 'running' || publishActive
  useEffect(() => {
    if (backendLive) setPendingFollowUp(false)
  }, [backendLive])

  // Only one phase streams at a time. Declared before socket hooks so `live`
  // is available for the execution socket's enabled prop (not in TDZ).
  const livePhase = isPlanningLive
    ? 'planning'
    : execLive
      ? 'executing'
      : valLiveState
        ? 'validation'
        : repairSession?.status === 'running'
          ? 'repair'
          : publishActive
            ? 'publishing'
            : undefined
  const live = livePhase !== undefined || pendingFollowUp

  // Task is in an active (non-terminal) lifecycle phase. Keeps sockets
  // connected through phase transitions (e.g., planning→execution during
  // auto-run) with no gap.
  const taskActive = task?.status != null && !['done', 'no_changes', 'failed', 'cancelled'].includes(task.status)

  // ── Live subscriptions ──────────────────────────────────────────────────
  useSocketChannel({
    channel: 'planning',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/stream`,
    enabled: Boolean(repoId && taskId) && isPlanning,
  })
  useSocketChannel({
    channel: 'execution',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/execution/stream`,
    // Connect the execution socket throughout the task's active lifecycle —
    // even across gaps between phases (planning→execution during auto-run).
    // The `taskActive` flag keeps the socket alive while the task is in a
    // non-terminal state, so the transition from planning→execution has no
    // disconnect window. Backend event buffering (30min) ensures any events
    // generated before the socket connected are replayed on connect.
    enabled: Boolean(repoId && taskId) && (execLive || live || taskActive),
  })
  useSocketChannel({
    channel: 'validation',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/validation/stream`,
    enabled: Boolean(repoId && taskId) && Boolean(valLiveState),
  })
  useRepairStream(repairSession?.id, Boolean(repairSession))
  usePublishingStream(publishSession?.id, publishActive)

  const planEvents = useAppSelector((s) => (taskId ? s.stream.planning[taskId]?.events ?? [] : []))
  const execEvents = useAppSelector((s) => (taskId ? s.stream.execution[taskId]?.events ?? [] : []))
  const valEvents = useAppSelector((s) => (taskId ? s.stream.validation[taskId]?.events ?? [] : []))
  const repairEvents = useAppSelector((s) =>
    repairSession?.id ? s.stream.repair[repairSession.id]?.events ?? [] : [],
  )
  const pubEvents = useAppSelector((s) =>
    publishSession?.id ? s.stream.publishing[publishSession.id]?.events ?? [] : [],
  )

  // React only to the COMMITTED terminal events the backend emits after it has
  // persisted the plan and transitioned status. We deliberately ignore the raw
  // mid-stream "plan" event (fanned before persistence) — reacting to it would
  // race the DB write. No polling: the socket is the source of truth.
  const lastPlan = planEvents[planEvents.length - 1]?.event
  useEffect(() => {
    if (lastPlan && ['plan_ready', 'planning_failed'].includes(String(lastPlan))) {
      refetchTask()
    }
  }, [lastPlan, planEvents.length, refetchTask])

  // ── Refetch persisted data on terminal live events ────────────────────────
  const lastExec = execEvents[execEvents.length - 1]?.kind
  useEffect(() => {
    if (lastExec && ['step_complete', 'exec_complete', 'error', 'execution_error'].includes(lastExec)) {
      refetchExec()
      refetchDiffs()
      refetchTask()
    }
  }, [lastExec, execEvents.length, refetchExec, refetchDiffs, refetchTask])

  const lastVal = valEvents[valEvents.length - 1]?.kind
  useEffect(() => {
    if (lastVal === 'validation_complete') {
      refetchVal()
      refetchTask() // pick up done / failed_repairable transition
    } else if (lastVal === 'stage_complete') {
      refetchVal()
    }
  }, [lastVal, valEvents.length, refetchVal, refetchTask])

  const lastRepair = repairEvents[repairEvents.length - 1]?.event
  useEffect(() => {
    if (lastRepair === 'repair_complete' || lastRepair === 'repair_escalated') {
      refetchVal()
      refetchTask()
      refetchRepair()
    } else if (lastRepair === 'attempt_complete') {
      // Refetch repair session to pick up updated attempts_used count
      refetchRepair()
    }
  }, [lastRepair, repairEvents.length, refetchVal, refetchTask, refetchRepair])

  const lastPub = pubEvents[pubEvents.length - 1]?.event
  useEffect(() => {
    if (lastPub === 'publishing_complete') {
      refetchPublish() // pull final pr_url / status
      refetchTask()
    }
  }, [lastPub, pubEvents.length, refetchPublish, refetchTask])

  // ── Normalize ──────────────────────────────────────────────────────────────
  const validationStages = useMemo(
    () => buildValidationStages(valSnap?.stages ?? [], valEvents),
    [valSnap, valEvents],
  )
  const repairAttempts = useMemo(
    () => buildRepairAttempts(repairSession, repairEvents),
    [repairSession, repairEvents],
  )
  const fileChanges = useMemo(() => buildFileChanges(diffs), [diffs])

  // ── Actions ──────────────────────────────────────────────────────────────
  const [approve, { isLoading: approving }] = useApproveTaskMutation()
  const [replan, { isLoading: replanning }] = useReplanTaskMutation()
  const [refinePlan, { isLoading: refining }] = useRefinePlanMutation()
  const [followUp, { isLoading: followingUp }] = useFollowUpMutation()
  const { data: messagesData } = useListMissionMessagesQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )

  // ── Per-turn artifact cache ───────────────────────────────────────────────
  // Persisted to localStorage so the full conversation history survives page
  // refresh. Cleared only when the user re-plans or the backend resets.
  const [turnArtifacts, setTurnArtifacts] = useState<Record<number, TurnArtifacts>>(
    () => loadStoredArtifacts(taskId),
  )
  const currentTurn = useMemo(() => {
    const maxTurn = (messagesData?.messages ?? []).reduce(
      (mx, m) => Math.max(mx, m.turn_number),
      1,
    )
    return maxTurn
  }, [messagesData?.messages])

  // Compute the timestamp of the first user message for each turn, so we can
  // determine which turn an artifact belongs to by its created_at.
  const turnBoundaryCache = useMemo(() => {
    const map: Record<number, number> = {}
    const msgs = messagesData?.messages ?? []
    // Turn 1 has no preceding user message — everything before the first
    // follow-up belongs to turn 1, so boundary is 0.
    map[1] = 0
    for (const m of msgs) {
      if (m.role === 'user' && m.turn_number > 1) {
        const t = new Date(m.created_at).getTime()
        // Track the EARLIEST user message for this turn (the one that started it)
        if (!map[m.turn_number] || t < map[m.turn_number]) {
          map[m.turn_number] = t
        }
      }
    }
    return map
  }, [messagesData?.messages])

  // Snapshot current artifacts whenever they change, keyed by the current turn.
  // Persists to localStorage so the full conversation survives page refresh.
  useEffect(() => {
    setTurnArtifacts((prev) => {
      const boundary = turnBoundaryCache[currentTurn] ?? 0
      const snapshot = { ...(prev[currentTurn] ?? { fileChanges: [], validationStages: [], repairAttempts: [], publishingSession: null }) }

      // Plan: only cache if it was created after this turn started
      if (plan) {
        const planTime = plan.created_at ? new Date(plan.created_at).getTime() : 0
        if (planTime >= boundary) snapshot.plan = plan
      }
      // File changes: only cache if execution started after this turn
      // Fallback: if execution is actively running, assume data belongs to current turn
      if (fileChanges.length > 0) {
        const execTime = execution?.started_at ? new Date(execution.started_at).getTime() : 0
        if (execTime >= boundary || (execLive && execTime === 0)) snapshot.fileChanges = fileChanges
      }
      // Validation: only cache if validation run started after this turn
      // Fallback: if validation is actively streaming, assume data belongs to current turn
      if (validationStages.length > 0) {
        const valTime = valRun?.created_at ? new Date(valRun.created_at).getTime() : 0
        if (valTime >= boundary || (valLiveState && valTime === 0)) {
          snapshot.validationStages = validationStages
          snapshot.validationOverall = valRun?.overall_result
        }
      }
      // Repair: only cache if repair session started after this turn
      // Fallback: if repair is actively running, assume data belongs to current turn
      if (repairAttempts.length > 0) {
        const repairTime = repairSession?.created_at ? new Date(repairSession.created_at).getTime() : 0
        const repairLive = repairSession?.status === 'running'
        if (repairTime >= boundary || (repairLive && repairTime === 0)) snapshot.repairAttempts = repairAttempts
      }
      // Publishing: only cache if publish session started after this turn
      // Fallback: if publishing is actively running, assume data belongs to current turn
      if (publishSession) {
        const pubTime = publishSession.created_at ? new Date(publishSession.created_at).getTime() : 0
        const pubLive = publishActive
        if (pubTime >= boundary || (pubLive && pubTime === 0)) snapshot.publishingSession = publishSession
      }

      const next = { ...prev, [currentTurn]: snapshot }
      saveStoredArtifacts(taskId, next)
      return next
    })
  }, [currentTurn, turnBoundaryCache, plan, fileChanges, validationStages, valRun?.overall_result, repairAttempts, publishSession, execution?.started_at, valRun?.created_at, repairSession?.created_at, publishSession?.created_at, taskId])

  const conversation = useMemo(
    () =>
      buildConversation({
        intent: task?.intent ?? '',
        planning: planEvents,
        execution: execEvents,
        validation: valEvents,
        repair: repairEvents,
        publishing: pubEvents,
        turnArtifacts,
        livePhase,
        messages: messagesData?.messages ?? [],
      }),
    [
      task?.intent, planEvents, execEvents, valEvents, repairEvents, pubEvents,
      turnArtifacts, livePhase, messagesData?.messages,
    ],
  )
  // The cross-phase Stop: /collaborate/stop marks the execution cancelled AND
  // cancels the pipeline context, which is the only thing that halts validation
  // and repair (they don't watch the work-item status that cancelTask flips).
  const [stopExecution, { isLoading: stopping }] = useStopExecutionMutation()
  const [cancel] = useCancelTaskMutation()
  const [startExec, { isLoading: starting }] = useStartExecutionMutation()
  const [startValidation, { isLoading: validating }] = useStartValidationMutation()
  const [provisionWorkspace, { isLoading: provisioning }] = useProvisionWorkspaceMutation()
  const [startPublish, { isLoading: publishStarting }] = useStartPublishMutation()

  // Explicit "Proceed" gate before publishing: the mission-done step offers
  // Re-plan or Proceed; only after Proceed do we reveal Publish to GitHub, so a
  // PR is created only on that deliberate final click — never automatically.
  const [proceeded, setProceeded] = useState(false)
  // Re-plan is destructive (wipes the current run), so it goes through a confirm.
  const [replanConfirmOpen, setReplanConfirmOpen] = useState(false)

  // Plan mode (persisted, global). OFF → auto-run when the plan is ready.
  const [planMode, setPlanMode] = useState<boolean>(() => loadPlanMode())
  const togglePlanMode = () => {
    setPlanMode((prev) => {
      const next = !prev
      savePlanMode(next)
      return next
    })
  }

  // Approve the ready plan and run it end-to-end (provision workspace → execute).
  // Shared by the manual "Approve & run" button and the auto-run path.
  async function approveAndRun() {
    try {
      await approve({ repoId, taskId }).unwrap()
      toast.success('Plan approved — provisioning workspace…')
      const ws = await provisionWorkspace({ repoId, taskId }).unwrap()
      refetchWorkspace()
      refetchTask()
      if (ws?.status === 'ready') {
        toast.success('Workspace ready — starting execution…')
        await startExec({ repoId, taskId }).unwrap()
        refetchExec()
        refetchTask()
      }
    } catch {
      toast.error('Failed to start — check the console')
      refetchTask()
      refetchWorkspace()
    }
  }

  // Auto-run: when a task flagged "auto-run" reaches plan_ready, skip the review
  // gate and run it automatically. The localStorage flag is cleared the instant
  // it fires, and a ref guards against a double-trigger (StrictMode / refetch).
  // Whether this task auto-runs — the server is the source of truth. The backend
  // performs approve → provision → execute itself once the plan is ready; the
  // frontend only reflects it (hide the plan card + review controls).
  const taskAutoRun = taskData?.autoRun ?? false

  // Tier 1 follow-up: refine the plan while reviewing it. The submitted notes are
  // shown as user bubbles for the session; the refined plan streams in below.
  const [refineNote, setRefineNote] = useState('')
  const [sentRefinements, setSentRefinements] = useState<string[]>([])

  async function handleRefine() {
    const note = refineNote.trim()
    if (!note) return
    setSentRefinements((prev) => [...prev, note])
    setRefineNote('')
    const ok = await run(
      refinePlan({ repoId, taskId, note }).unwrap(),
      'Refining the plan…',
      'Could not refine the plan',
    )
    if (ok) {
      refetchTask()
    } else {
      // Roll the optimistic bubble back so the user can retry.
      setSentRefinements((prev) => prev.filter((n) => n !== note))
      setRefineNote(note)
    }
  }

  // After a mission ends, sending a follow-up stays on the same thread and
  // re-plans using accumulated chat history — Claude-Code-style persistent chat.
  async function handleFollowUp() {
    const msg = refineNote.trim()
    if (!msg) return
    setSentRefinements((prev) => [...prev, msg])
    setRefineNote('')
    setPendingFollowUp(true)
    try {
      await followUp({ repoId, taskId, message: msg, auto_run: !planMode }).unwrap()
      refetchTask()
    } catch {
      setSentRefinements((prev) => prev.filter((n) => n !== msg))
      setRefineNote(msg)
      setPendingFollowUp(false)
      toast.error('Could not send follow-up')
    }
  }

  const dispatch = useAppDispatch()

  // Re-plan = start a completely fresh cycle. The backend wipes the previous
  // run's artifacts (execution/diffs/validation/repair/publishing); here we
  // clear the client-side event streams and localStorage cache so the thread
  // doesn't show any of the old run while the new plan is generated.
  async function handleReplan() {
    setProceeded(false)
    const ok = await run(
      replan({ repoId, taskId }).unwrap(),
      'Re-planning — starting fresh',
      'Failed to re-plan',
    )
    setReplanConfirmOpen(false)
    if (ok === false) return
    setTurnArtifacts({})
    localStorage.removeItem(`${STORAGE_PREFIX}-${taskId}`)
    if (taskId) dispatch(taskStreamsReset(taskId))
    if (publishSession?.id) dispatch(clearPublishingEvents(publishSession.id))
    if (repairSession?.id) dispatch(clearRepairEvents(repairSession.id))
    refetchTask()
    refetchExec()
    refetchDiffs()
    refetchVal()
    refetchRepair()
    refetchPublish()
    refetchWorkspace()
  }

  async function run<T>(p: Promise<T>, ok: string, err: string): Promise<boolean> {
    try {
      await p
      toast.success(ok)
      return true
    } catch {
      toast.error(err)
      return false
    }
  }

  if (!repoId) {
    return (
      <EmptyState
        icon={<Icon name="alert" size={32} />}
        title="Missing repository context"
        description="Open this mission from the console or the mission list."
        action={<Button variant="secondary" onClick={() => navigate(ROUTES.root)}>Go to console</Button>}
      />
    )
  }
  if (isLoading) return <div className={styles.center}><Spinner size={22} /></div>
  if (!task) {
    return (
      <EmptyState
        icon={<Icon name="task" size={32} />}
        title="Mission not found"
        action={<Button variant="secondary" onClick={() => navigate(ROUTES.root)}>Back to console</Button>}
      />
    )
  }

  // ── Next-action logic — every state exposes an obvious next step ──────────
  const status = task.status
  const execStatus = execution?.status
  const overall = valRun?.overall_result
  const repairing = repairSession?.status === 'running'
  const workspaceStatus = workspace?.status

  // plan_ready always needs a human decision — don't gate on the exact
  // approval_status string (backend uses pending_review, not "pending").
  const approved = ['approved', 'auto_approved'].includes(task.approval_status)
  const canApprove = status === 'plan_ready' && !approved
  const workspaceReady = workspaceStatus === 'ready'
  const canExecute = approved && status === 'plan_approved' && workspaceReady && !execution
  const isExecuting = execStatus === 'running' || execStatus === 'pending'
  const execDone = execStatus === 'completed'
  const canValidate = execDone && !valRun && !validating
  const missionNoChanges = status === 'no_changes'
  const missionDone = status === 'done' || overall === 'passed'
  const missionFailed = status === 'failed' || status === 'cancelled'
  const prUrl = publishSession?.status === 'completed' ? publishSession.pr_url : null

  // Plan approve/reject/replan renders directly on the plan card — that's
  // where the decision belongs, not in a page-level header.
  const planActions = canApprove && !taskAutoRun ? (
    <>
      <Button key="replan" variant="ghost" loading={replanning}
        onClick={() => setReplanConfirmOpen(true)}>
        Edit / Re-plan
      </Button>
      <Button key="reject" variant="danger"
        onClick={() => run(cancel({ repoId, taskId }).unwrap(), 'Plan rejected', 'Failed to reject')}>
        Reject
      </Button>
      <Button key="approve" variant="primary" loading={approving || provisioning || starting} leadingIcon={<Icon name="check" size={15} />}
        onClick={approveAndRun}>
        Approve &amp; run
      </Button>
    </>
  ) : undefined

  // Every other next step is the one contextual action at the end of the
  // thread — the reference product's inline CTA button, not a header full of
  // competing controls.
  let actionRow: React.ReactNode = null
  if (canExecute) {
    actionRow = (
      <Button key="exec" variant="primary" loading={starting} leadingIcon={<Icon name="play" size={15} />}
        onClick={() => run(startExec({ repoId, taskId }).unwrap(), 'Execution started', 'Failed to start')}>
        Start execution
      </Button>
    )
  } else if (isExecuting) {
    // Stop lives in the persistent composer now, so no separate cancel button here.
    actionRow = null
  } else if (canValidate) {
    actionRow = (
      <Button key="validate" variant="primary" loading={validating} leadingIcon={<Icon name="check" size={15} />}
        onClick={() => run(startValidation({ repoId, taskId }).unwrap(), 'Validation started', 'Failed to validate')}>
        Run validation
      </Button>
    )
  } else if (missionDone && !isExecuting && !repairing) {
    const hasChanges = fileChanges.length > 0
    const publishSlotOpen =
      !prUrl && !publishActive &&
      (!publishSession || publishSession.status === 'failed' || publishSession.status === 'cancelled')
    if (!hasChanges) {
      // Nothing was modified — there is nothing to publish. Surface it up front
      // instead of letting the user hit a "no code diff" failure at publish time.
      actionRow = (
        <Button key="nochanges" variant="secondary" disabled leadingIcon={<Icon name="alert" size={15} />}>
          No changes to publish
        </Button>
      )
    } else if (publishSlotOpen) {
      // Decision gate: Re-plan or Proceed. Publish (which creates the PR) is only
      // revealed after the user explicitly proceeds — nothing publishes on its own.
      actionRow = (
        <>
          <Button key="replan" variant="ghost" loading={replanning} leadingIcon={<Icon name="refresh" size={15} />}
            onClick={() => setReplanConfirmOpen(true)}>
            Re-plan
          </Button>
          {proceeded ? (
            <Button key="publish" variant="primary" loading={publishStarting} leadingIcon={<Icon name="git" size={15} />}
              onClick={async () => {
                await run(startPublish({ repoId, taskId }).unwrap(),
                  'Publishing to GitHub…',
                  'Failed to start publishing')
                refetchPublish()
                refetchTask()
              }}>
              {publishSession?.status === 'failed' ? 'Retry publish' : 'Publish to GitHub'}
            </Button>
          ) : (
            <Button key="proceed" variant="primary" leadingIcon={<Icon name="check" size={15} />}
              onClick={() => setProceeded(true)}>
              Proceed
            </Button>
          )}
        </>
      )
    }
  } else if (missionFailed) {
    actionRow = (
      <Button key="retry" variant="primary" loading={replanning} leadingIcon={<Icon name="refresh" size={15} />}
        onClick={() => setReplanConfirmOpen(true)}>
        Re-plan &amp; retry
      </Button>
    )
  } else if (missionNoChanges) {
    // The run produced no diff — nothing to publish. Offer a re-plan so the
    // user can refine the request or point at the specific file/symptom.
    actionRow = (
      <Button key="nochanges-replan" variant="primary" loading={replanning} leadingIcon={<Icon name="refresh" size={15} />}
        onClick={() => setReplanConfirmOpen(true)}>
        Re-plan &amp; retry
      </Button>
    )
  }

  const liveHint = isPlanningLive
    ? 'Planning…'
    : isExecuting
      ? 'Executing…'
      : valLiveState
        ? 'Validating…'
        : repairing
          ? 'Repairing…'
          : publishActive
            ? (publishSession?.current_step ? `Publishing · ${publishSession.current_step}` : 'Publishing…')
            : undefined

  // ── Hero: phase title + honest pipeline-position ring ─────────────────────
  const heroProgress = missionFailed || missionDone || missionNoChanges
    ? 1
    : publishActive
      ? 0.92
      : repairing
        ? 0.85
        : valLiveState
          ? 0.78
          : execDone
            ? 0.66
            : isExecuting
              ? 0.55
              : status === 'plan_approved'
                ? 0.34
                : status === 'plan_ready'
                  ? 0.22
                  : isPlanningLive
                    ? 0.12
                    : 0.05
  const heroTone: 'active' | 'success' | 'danger' | 'neutral' = missionFailed
    ? 'danger'
    : missionDone
      ? 'success'
      : missionNoChanges
        ? 'neutral'
        : live
          ? 'active'
          : 'neutral'
  const heroTitle = isPlanningLive
    ? 'Planning your changes'
    : isExecuting
      ? 'Writing code'
      : valLiveState
        ? 'Validating changes'
        : repairing
          ? 'Repairing issues'
          : publishActive
            ? 'Publishing to GitHub'
            : missionDone
              ? 'Mission complete'
              : missionNoChanges
                ? 'No changes made'
                : missionFailed
                ? (status === 'cancelled' ? 'Mission cancelled' : 'Mission failed')
                : canApprove
                  ? 'Plan ready for your review'
                  : canValidate
                    ? 'Ready to validate'
                    : canExecute
                      ? 'Ready to execute'
                      : 'Mission'

  const hero = (
    <MissionHero
      title={heroTitle}
      subtitle={task.intent}
      progress={heroProgress}
      live={live}
      tone={heroTone}
      right={
        <>
          <StatusBadge map={WORK_ITEM_STATUS} status={task.status} size="sm" />
          {prUrl && (
            <a className={styles.prChip} href={prUrl} target="_blank" rel="noreferrer">
              <Icon name="git" size={13} /> {publishSession?.pr_number ? `#${publishSession.pr_number}` : 'PR'}
            </a>
          )}
        </>
      }
    />
  )

  const header = (
    <div className={styles.header}>
      <div className={styles.headerLeft}>
        <button className={styles.back} onClick={() => navigate(ROUTES.root)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className={styles.crumb}>WORKSPACE / {taskId.slice(0, 8).toUpperCase()}</span>
        <span className={styles.headerDivider} />
        <Icon name="git" size={13} className={styles.headerGitIcon} />
        <span className={styles.headerRepoName}>{repoId ? `repo-${repoId.slice(0, 6)}` : 'No repo'}</span>
      </div>
      <div className={styles.headerRight}>
        <ConnectionStatus />
        {live && (
          <span className={styles.headerLive}>
            <span className={styles.liveDot}><span /></span>
            {liveHint ?? 'live'}
          </span>
        )}
        <span className={styles.headerGpu}>GPU: H100 Node 4</span>
        <div className={styles.headerGpuDot} />
        {workspace && (workspace.status === 'ready' || workspace.status === 'executing') && (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Icon name="code" size={14} />}
            onClick={() => navigate(routeTo.workspaceEditor(workspace.id, taskId, repoId))}
          >
            Open IDE
          </Button>
        )}
      </div>
    </div>
  )

  // Persistent composer — always visible, like a coding assistant. Its behavior
  // adapts to the mission phase:
  //   • agent working   → Stop button (cancels the run)
  //   • reviewing plan  → Send button refines the plan (Tier 1)
  //   • otherwise       → input disabled with a contextual hint (Tier 2 will
  //                       enable follow-ups after completion)
  const canRefine = canApprove
  const canStartNew = missionDone || missionFailed || missionNoChanges
  const showStop = live
  const composerBusy = refining || followingUp
  // The input is typeable while reviewing a plan (refine) or once the mission has
  // ended (start a new one). It's only disabled during the brief transient states
  // (e.g. approved-and-provisioning) where neither action applies.
  const inputEnabled = !showStop && (canRefine || canStartNew)

  function submitComposer() {
    if (canRefine) handleRefine()
    else if (canStartNew) handleFollowUp()
  }

  async function handleStop() {
    let ok = false
    // 1) Halt whatever is actually running. Once a workspace exists
    //    (execution/validation/repair), collaborate/stop cancels the execution
    //    AND the pipeline context — the only thing that stops validation/repair.
    if (workspace?.id) {
      try {
        await stopExecution(workspace.id).unwrap()
        ok = true
      } catch {
        /* fall through to the mission-level cancel */
      }
    }
    // 2) Move the mission itself to a terminal state so the header/hero stop
    //    showing a live phase (collaborate/stop cancels the run, not the work
    //    item). Ignored if it's already terminal.
    try {
      await cancel({ repoId, taskId }).unwrap()
      ok = true
    } catch {
      /* already terminal — treat as stopped */
    }
    toast[ok ? 'success' : 'error'](ok ? 'Stopped' : 'Failed to stop')
    refetchExec()
    refetchVal()
    refetchRepair()
    refetchPublish()
    refetchTask()
  }

  const composerPlaceholder = showStop
    ? 'Forge is working… click Stop to cancel.'
    : canRefine
      ? 'Refine the plan — e.g. “also handle the empty-list case”. ⌘/Ctrl+Enter to send.'
      : canStartNew
        ? (planMode
            ? 'Send a follow-up — Forge will plan it for your review. ⌘/Ctrl+Enter.'
            : 'Send a follow-up — Forge will plan and run it automatically. ⌘/Ctrl+Enter.')
        : 'Follow-ups are available while a plan is under review.'

  const composer = (
    <>
      <div className={styles.composerBox}>
        <textarea
          className={styles.composerInput}
          value={refineNote}
          onChange={(e) => setRefineNote(e.target.value)}
          placeholder={composerPlaceholder}
          rows={1}
          disabled={!inputEnabled || composerBusy}
          onKeyDown={(e) => {
            if (inputEnabled && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submitComposer()
            }
          }}
        />
        {showStop ? (
          <Button
            variant="danger"
            loading={stopping}
            leadingIcon={<Icon name="stop" size={13} />}
            onClick={handleStop}
          >
            Stop
          </Button>
        ) : canStartNew ? (
          <>
            <button
              type="button"
              className={`${styles.planToggle} ${planMode ? styles.planToggleOn : ''}`}
              onClick={togglePlanMode}
              title={planMode
                ? 'Plan first — review the plan before it runs'
                : 'Auto-run — plan and execute without a review step'}
              aria-pressed={planMode}
            >
              <Icon name={planMode ? 'check' : 'play'} size={12} />
              Plan
            </button>
            <Button
              variant="primary"
              loading={followingUp}
              disabled={!refineNote.trim()}
              leadingIcon={<Icon name="chevronRight" size={14} />}
              onClick={handleFollowUp}
            >
              {planMode ? 'Follow up' : 'Run'}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            loading={refining}
            disabled={!canRefine || !refineNote.trim()}
            leadingIcon={<Icon name="chat" size={14} />}
            onClick={handleRefine}
          >
            Refine plan
          </Button>
        )}
      </div>
      <div className={styles.composerFooter}>
        <div className={styles.composerStatusLeft}>
          <span className={styles.composerStatusItem}>
            <Icon name="code" size={11} className={styles.composerStatusIconGreen} />
            Shell Sandbox listening
          </span>
          <span className={styles.composerStatusDivider} />
          <span className={styles.composerStatusItem}>
            <Icon name="tool" size={11} className={styles.composerStatusIconCyan} />
            Safe Mode: Activated
          </span>
        </div>
        <span className={styles.composerShortcut}>Ctrl + Enter to submit</span>
      </div>
    </>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
      {/* Status Bar - Always visible at top */}
      <TaskStatusBar />

      {/* Main Content Area */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: '1px', background: 'var(--border-subtle)' }}>
        {/* Left: Activity Panel + File Explorer */}
        <div style={{ display: 'flex', flexDirection: 'column', width: '280px', minHeight: 0, background: 'var(--surface-base)' }}>
          {/* Activity Feed */}
          <div style={{ flex: '1 1 40%', minHeight: 0, borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ padding: '8px 12px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
              AI Activity
            </div>
            <AIActivityPanel />
          </div>

          {/* File Explorer */}
          <div style={{ flex: '1 1 60%', minHeight: 0 }}>
            <div style={{ padding: '8px 12px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
              Files
            </div>
            <FileExplorer />
          </div>
        </div>

        {/* Center: Main Mission Thread */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          <MissionThread
            header={header}
            hero={hero}
            entries={conversation.filter(
              (e) => e.type !== 'intent' && !(taskAutoRun && e.type === 'plan'),
            )}
            live={live}
            planActions={planActions}
            actionRow={actionRow}
            trailingMessages={(() => {
              const serverMsgs = (messagesData?.messages ?? [])
                .filter((m) => m.role === 'user' && m.turn_number > 1)
                .map((m) => m.content)
              const serverSet = new Set(serverMsgs)
              const pending = sentRefinements.filter((r) => !serverSet.has(r))
              return pending
            })()}
            composer={composer}
          />
        </div>

        {/* Right: Live Preview */}
        <div style={{ width: '400px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LivePreview />
        </div>
      </div>

      <ConfirmDialog
        open={replanConfirmOpen}
        danger
        title="Re-plan from scratch?"
        confirmLabel="Yes, re-plan"
        cancelLabel="Keep current"
        loading={replanning}
        message={
          <>
            This starts a completely fresh cycle. The current run's work — the plan,
            code changes, validation results, and any pull request created for it —
            will be discarded and <strong>cannot be recovered</strong>.
          </>
        }
        onConfirm={handleReplan}
        onCancel={() => setReplanConfirmOpen(false)}
      />
    </div>
  )
}

export default TaskWorkspace
