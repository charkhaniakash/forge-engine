import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, ConfirmDialog, EmptyState, Icon, Spinner, StatusBadge } from '@/components/common'
import { MissionThread } from '@/features/task-workspace'
import { TaskStatusBar } from '@/features/workspace/TaskStatusBar'
import { LivePreview } from '@/features/workspace/LivePreview'
import { CodeEditor } from '@/features/workspace/CodeEditor'
import { FileExplorer } from '@/features/workspace/FileExplorer'
import { useWorkspaceSocket } from '@/hooks/useWorkspaceSocket'
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
import { useStopExecutionMutation, useGetFileTreeQuery } from '@/services/api/workspaceEditorApi'
import { setFileTree } from '@/store/slices/workspaceEditorSlice'
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
import { ROUTES } from '@/constants/routes'

const EXEC_LIVE = new Set(['pending', 'running'])
const STORAGE_PREFIX = 'forge-turn-artifacts'
// Stable empty array — returning a fresh `[]` from a useAppSelector on every
// evaluation creates a new reference each render, which flows into useMemo
// deps → effect deps → setState → re-render → new reference… an infinite
// "Maximum update depth exceeded" loop. A module-level constant keeps the
// reference identical so empty streams don't trigger re-renders.
const NO_EVENTS: never[] = []
const NO_DIFFS: never[] = []

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
  // Execution finished → the backend auto-triggers validation ~1s later. Used to
  // proactively connect the validation socket + poll for the run so the UI flips
  // to "Validating" on its own (no manual refresh).
  const execCompleted = execution?.status === 'completed'

  const { data: diffsData, refetch: refetchDiffs } = useGetExecutionDiffsQuery(
    { repoId, taskId },
    { skip: !execution },
  )
  // Stable reference — the inline `= []` default creates a new array ref on
  // every render when the query is skipped, making useMemo deps unstable.
  const diffs = diffsData ?? NO_DIFFS

  const { data: valSnap, refetch: refetchVal } = useGetValidationQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const valRun = valSnap?.run
  const valLiveState = valRun?.status === 'running' || valRun?.status === 'pending'
  // Validation finishing with a non-passed result auto-triggers a repair session
  // server-side — used to discover repair without a manual refresh.
  const valFailed = valRun?.overall_result != null && valRun.overall_result !== 'passed'

  const { data: repairSession, refetch: refetchRepair } = useGetRepairSessionByTaskQuery(taskExecutionId, {
    skip: !taskExecutionId,
  })

  const { data: workspace, refetch: refetchWorkspace } = useGetWorkspaceQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )

  // Connect the workspace socket for THIS page so the embedded code editor
  // receives the agent's live file edits (aiFileStreamed) and opens/streams
  // them in real time — v0-style — without navigating to the separate IDE page.
  // The hook no-ops until a workspace id exists.
  useWorkspaceSocket(workspace?.id ?? '')

  // Right panel: live code editor (default, v0-style) vs. running-app preview.
  const [rightTab, setRightTab] = useState<'code' | 'preview'>('code')

  // Auto-run provisions the workspace server-side — the mount-time query above
  // predates it (and 404s, leaving `workspace` null). Refetch the instant the
  // execution phase begins so the Live Preview gets a real workspace ID.
  const prevExecLive = useRef(false)
  useEffect(() => {
    if (execLive && !prevExecLive.current) refetchWorkspace()
    prevExecLive.current = execLive
  }, [execLive, refetchWorkspace])

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
    // Connect as soon as execution completes (not only once validation is already
    // running) so the auto-triggered validation's events stream in immediately —
    // breaks the chicken-and-egg where the socket waited for a run that the socket
    // itself was supposed to surface.
    enabled: Boolean(repoId && taskId) && (valLiveState || execCompleted),
  })
  useRepairStream(repairSession?.id, Boolean(repairSession))
  usePublishingStream(publishSession?.id, publishActive)

  const planEvents = useAppSelector((s) => (taskId ? s.stream.planning[taskId]?.events ?? NO_EVENTS : NO_EVENTS))
  const execEvents = useAppSelector((s) => (taskId ? s.stream.execution[taskId]?.events ?? NO_EVENTS : NO_EVENTS))
  const valEvents = useAppSelector((s) => (taskId ? s.stream.validation[taskId]?.events ?? NO_EVENTS : NO_EVENTS))
  const repairEvents = useAppSelector((s) =>
    repairSession?.id ? s.stream.repair[repairSession.id]?.events ?? NO_EVENTS : NO_EVENTS,
  )
  const pubEvents = useAppSelector((s) =>
    publishSession?.id ? s.stream.publishing[publishSession.id]?.events ?? NO_EVENTS : NO_EVENTS,
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
      // Guard: refetchDiffs throws "query has not been started yet" when the
      // diffs query is still skipped (execution was null at subscribe time).
      if (execution) refetchDiffs()
      refetchTask()
      // Belt-and-suspenders: re-query the workspace on execution events too, in
      // case the rising-edge refetch landed before the workspace row committed.
      refetchWorkspace()
      // Execution finishing auto-triggers server-side validation — pull the
      // validation snapshot so the thread flips to "Validating" without a manual
      // refresh. The run row may not exist this instant; the poll below covers it.
      refetchVal()
    }
  }, [lastExec, execEvents.length, refetchExec, refetchDiffs, refetchTask, refetchWorkspace, refetchVal])

  const lastVal = valEvents[valEvents.length - 1]?.kind
  useEffect(() => {
    if (!lastVal) return
    // ANY validation event (started / stage_started / stage_complete / complete)
    // refreshes the run — so the very first event surfaces the run and flips the
    // UI to "Validating" live, and each stage updates without a refresh.
    refetchVal()
    if (lastVal === 'validation_complete') {
      refetchTask() // pick up done / failed_repairable transition
      refetchRepair() // a failed validation auto-triggers repair — discover it now
    }
  }, [lastVal, valEvents.length, refetchVal, refetchTask, refetchRepair])

  // Discovery poll: the auto-triggered validation run is created ~1s after
  // execution completes. Poll briefly until it appears so the UI surfaces
  // "Validating" on its own; stops the moment the run exists (the socket then
  // drives live stage updates). This is the belt to the socket's suspenders.
  useEffect(() => {
    if (!execCompleted || valRun) return
    const id = setInterval(() => refetchVal(), 1500)
    return () => clearInterval(id)
  }, [execCompleted, valRun, refetchVal])

  const lastRepair = repairEvents[repairEvents.length - 1]?.event
  useEffect(() => {
    if (!lastRepair) return
    // ANY repair event (repair_started / strategy / attempt_started / attempt_complete)
    // refreshes the session — so repair surfaces live and each attempt updates
    // without a refresh.
    refetchRepair()
    if (lastRepair === 'repair_complete' || lastRepair === 'repair_escalated') {
      refetchVal()
      refetchTask()
    }
  }, [lastRepair, repairEvents.length, refetchVal, refetchTask, refetchRepair])

  // Discovery poll: a failed validation auto-triggers a repair session server-side.
  // Poll until it appears so the thread shows "Repairing" on its own; stops the
  // moment the session exists (the repair socket then streams attempts live) or the
  // task reaches a terminal state.
  useEffect(() => {
    if (!valFailed || repairSession || !taskActive) return
    const id = setInterval(() => refetchRepair(), 1500)
    return () => clearInterval(id)
  }, [valFailed, repairSession, taskActive, refetchRepair])

  const lastPub = pubEvents[pubEvents.length - 1]?.event
  useEffect(() => {
    if (!lastPub) return
    // ANY publishing event (branch / commit / push / pr steps → complete) refreshes
    // the session so current_step / status update live in the thread — no refresh.
    refetchPublish()
    if (lastPub === 'publishing_complete') {
      refetchTask() // pick up final done / pr_url transition
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
  // Mutable ref mirrors the state so the snapshot effect can read the current
  // value synchronously (without capturing stale state in the closure) and
  // compare before ever calling setTurnArtifacts — breaking the render loop.
  const turnArtifactsRef = useRef<Record<number, TurnArtifacts>>(turnArtifacts)
  // Tracks the last JSON we committed per-turn so bail-out works even when
  // prev[currentTurn] is undefined (first render for a new turn).
  const lastSnapshotKeyRef = useRef<Record<number, string>>({})

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
  //
  // Root cause of "Maximum update depth exceeded":
  //   1. The old bail-out was `if (existing && ...)` — skipped when existing
  //      is undefined (first render for a new turn), always setting new state.
  //   2. `const { data: diffs = [] }` created a new [] ref every render when
  //      the query was skipped, making fileChanges unstable and re-firing the
  //      effect after every render triggered by the setState call above.
  //
  // Fix: build the snapshot outside setTurnArtifacts, compare via a ref that
  // is keyed per-turn (works even when there is no prior snapshot), and only
  // call setTurnArtifacts when the content actually changed.
  useEffect(() => {
    const boundary = turnBoundaryCache[currentTurn] ?? 0
    const prevTurn = turnArtifactsRef.current[currentTurn] ?? {
      fileChanges: [],
      validationStages: [],
      repairAttempts: [],
      publishingSession: null,
    }
    const snapshot: TurnArtifacts = { ...prevTurn }

    if (plan) {
      const planTime = plan.created_at ? new Date(plan.created_at).getTime() : 0
      if (planTime >= boundary) snapshot.plan = plan
    }
    if (fileChanges.length > 0) {
      const execTime = execution?.started_at ? new Date(execution.started_at).getTime() : 0
      if (execTime >= boundary || (execLive && execTime === 0)) snapshot.fileChanges = fileChanges
    }
    if (validationStages.length > 0) {
      const valTime = valRun?.created_at ? new Date(valRun.created_at).getTime() : 0
      if (valTime >= boundary || (valLiveState && valTime === 0)) {
        snapshot.validationStages = validationStages
        snapshot.validationOverall = valRun?.overall_result
      }
    }
    if (repairAttempts.length > 0) {
      const repairTime = repairSession?.created_at ? new Date(repairSession.created_at).getTime() : 0
      const repairLive = repairSession?.status === 'running'
      if (repairTime >= boundary || (repairLive && repairTime === 0)) snapshot.repairAttempts = repairAttempts
    }
    if (publishSession) {
      const pubTime = publishSession.created_at ? new Date(publishSession.created_at).getTime() : 0
      if (pubTime >= boundary || (publishActive && pubTime === 0)) snapshot.publishingSession = publishSession
    }

    const key = JSON.stringify(snapshot)
    if (lastSnapshotKeyRef.current[currentTurn] === key) return

    lastSnapshotKeyRef.current[currentTurn] = key
    const next = { ...turnArtifactsRef.current, [currentTurn]: snapshot }
    turnArtifactsRef.current = next
    saveStoredArtifacts(taskId, next)
    setTurnArtifacts(next)
  }, [
    currentTurn, turnBoundaryCache, plan, fileChanges, validationStages,
    valRun?.overall_result, repairAttempts, publishSession,
    execution?.started_at, execLive,
    valRun?.created_at, valLiveState,
    repairSession?.created_at, repairSession?.status,
    publishSession?.created_at, publishActive,
    taskId,
  ])

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

  // Load the workspace file tree into the editor slice so the embedded
  // FileExplorer shows files (clickable → opens in the right-side CodeEditor).
  // Without this the tree is empty on the mission page and nothing can be
  // selected. Refetches automatically on WS 'WsFiles' invalidation (agent edits).
  const { data: fileTreeData } = useGetFileTreeQuery(workspace?.id ?? '', {
    skip: !workspace?.id,
    refetchOnMountOrArgChange: true,
  })
  useEffect(() => {
    if (fileTreeData?.tree) dispatch(setFileTree(fileTreeData.tree))
  }, [fileTreeData, dispatch])

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
    turnArtifactsRef.current = {}
    lastSnapshotKeyRef.current = {}
    localStorage.removeItem(`${STORAGE_PREFIX}-${taskId}`)
    if (taskId) dispatch(taskStreamsReset(taskId))
    if (publishSession?.id) dispatch(clearPublishingEvents(publishSession.id))
    if (repairSession?.id) dispatch(clearRepairEvents(repairSession.id))
    refetchTask()
    refetchExec()
    if (execution) refetchDiffs()
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
  if (isLoading) return <div className="flex h-full items-center justify-center"><Spinner size={22} /></div>
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
            <a
              className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary no-underline hover:no-underline"
              href={prUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="git" size={13} /> {publishSession?.pr_number ? `#${publishSession.pr_number}` : 'PR'}
            </a>
          )}
        </>
      }
    />
  )

  // "Create PR" in the top bar maps to the publishing flow — enabled once the
  // mission is done with real changes and no PR is open yet.
  const canCreatePr =
    missionDone && fileChanges.length > 0 && !prUrl && !publishActive &&
    (!publishSession || ['failed', 'cancelled'].includes(publishSession.status))
  async function handleCreatePr() {
    await run(startPublish({ repoId, taskId }).unwrap(), 'Creating PR…', 'Failed to create PR')
    refetchPublish()
    refetchTask()
  }

  const header = (
    <div className="flex h-12 flex-shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3">
      {/* Left: back + breadcrumb */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          onClick={() => navigate(ROUTES.root)}
          aria-label="Back to console"
          className="flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Icon name="chevronLeft" size={16} />
        </button>
        <Icon name="branch" size={13} className="flex-shrink-0 text-fg-subtle" />
        <span className="flex-shrink-0 font-mono text-xs text-fg-subtle">
          {repoId ? `repo-${repoId.slice(0, 6)}` : 'no-repo'}
        </span>
        <Icon name="chevronRight" size={12} className="flex-shrink-0 text-fg-subtle opacity-50" />
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{task.intent}</span>
      </div>

      {/* Right: view toggle + live status + Create PR */}
      <div className="flex flex-shrink-0 items-center gap-2">
        {workspace?.id && (
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-base p-0.5">
            <button
              onClick={() => setRightTab('code')}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${rightTab === 'code' ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg'}`}
            >
              <Icon name="code" size={13} /> Code
            </button>
            <button
              onClick={() => setRightTab('preview')}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${rightTab === 'preview' ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg'}`}
            >
              <Icon name="monitor" size={13} /> Preview
            </button>
          </div>
        )}

        {live ? (
          <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-medium text-primary">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            {liveHint ?? 'Live'}
          </span>
        ) : missionDone ? (
          <span className="flex items-center gap-1 rounded-full border border-success/25 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
            <Icon name="check" size={12} /> Complete
          </span>
        ) : missionFailed ? (
          <span className="flex items-center gap-1 rounded-full border border-danger/25 bg-danger/10 px-2.5 py-1 text-[11px] font-semibold text-danger">
            <Icon name="x" size={12} /> Failed
          </span>
        ) : null}

        {prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground no-underline transition-all hover:no-underline hover:brightness-110"
          >
            <Icon name="git" size={14} />
            {publishSession?.pr_number ? `PR #${publishSession.pr_number}` : 'View PR'}
          </a>
        ) : (
          <button
            onClick={handleCreatePr}
            disabled={!canCreatePr || publishStarting}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="branch" size={14} /> Create PR
          </button>
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
      <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
        <textarea
          className="max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle disabled:opacity-50"
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
              className={`flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[11px] font-semibold transition-colors ${planMode ? 'border-primary/30 bg-primary/10 text-primary' : 'border-line text-fg-subtle hover:text-fg'}`}
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
      <div className="mt-1.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 font-mono text-[10px] text-fg-subtle">
            <Icon name="code" size={11} className="text-primary" />
            Shell sandbox listening
          </span>
          <span className="h-3 w-px bg-line" />
          <span className="flex items-center gap-1 font-mono text-[10px] text-fg-subtle">
            <Icon name="tool" size={11} className="text-tertiary" />
            Safe mode active
          </span>
        </div>
        <span className="font-mono text-[10px] text-fg-subtle opacity-70">⌘ + Enter to submit</span>
      </div>
    </>
  )

  const trailingMessages = (() => {
    const serverMsgs = (messagesData?.messages ?? [])
      .filter((m) => m.role === 'user' && m.turn_number > 1)
      .map((m) => m.content)
    const serverSet = new Set(serverMsgs)
    return sentRefinements.filter((r) => !serverSet.has(r))
  })()

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      {/* Top bar */}
      {header}

      {/* Main 2-column workspace body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: Mission Thread (~44%) */}
        <div className="flex w-[44%] min-w-[380px] max-w-[680px] flex-col overflow-hidden border-r border-line">
          <MissionThread
            header={hero}
            entries={conversation.filter(
              (e) => e.type !== 'intent' && !(taskAutoRun && e.type === 'plan'),
            )}
            live={live}
            planActions={planActions}
            actionRow={actionRow}
            trailingMessages={trailingMessages}
            composer={composer}
          />
        </div>

        {/* Right: Code Editor (~56%) — Code/Preview toggle lives in the top bar */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
          {workspace?.id ? (
            <>
              {/* Panels stay mounted so switching tabs preserves editor/iframe state */}
              <div style={{ flex: 1, minHeight: 0, display: rightTab === 'code' ? 'flex' : 'none', flexDirection: 'column' }}>
                <CodeEditor workspaceId={workspace.id} live={live} fileExplorer={<FileExplorer workspaceId={workspace.id} />} />
              </div>
              <div style={{ flex: 1, minHeight: 0, display: rightTab === 'preview' ? 'flex' : 'none', flexDirection: 'column' }}>
                <LivePreview workspaceId={workspace.id} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2 text-fg-subtle">
                <Icon name="code" size={24} />
              </div>
              <p className="text-sm font-semibold text-fg-muted">No workspace yet</p>
              <p className="max-w-[260px] text-xs leading-relaxed text-fg-subtle">
                {taskAutoRun || status === 'planning' || status === 'draft'
                  ? 'Forge is preparing the workspace — code will appear here as the agent edits files.'
                  : 'Approve the plan and run it. Code will stream in here as the agent works.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* VS Code-style status bar — at the bottom, always visible */}
      <TaskStatusBar livePhase={livePhase} isLive={live} />

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
