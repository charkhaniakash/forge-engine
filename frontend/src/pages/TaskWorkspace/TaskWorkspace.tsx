import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Button, ConfirmDialog, EmptyState, Icon, Spinner, StatusBadge } from '@/components/common'
import { MissionThread } from '@/features/task-workspace'
import { MissionHero } from '@/features/task-workspace/MissionHero'
import { useRepairStream } from '@/features/task-workspace/useRepairStream'
import {
  buildConversation,
  buildFileChanges,
  buildRepairAttempts,
  buildValidationStages,
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

export function TaskWorkspace() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  // ── Data ────────────────────────────────────────────────────────────────
  // Poll like the sibling snapshots: the WS 'plan_ready' event alone can race the
  // DB write / late socket connect, leaving task.status stale — which the auto-run
  // gate depends on. Polling guarantees the frontend observes plan_ready promptly.
  const { data: taskData, isLoading, refetch: refetchTask } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 3000 },
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
    { skip: !repoId || !taskId, pollingInterval: 3000 },
  )
  const valRun = valSnap?.run
  const valLiveState = valRun?.status === 'running' || valRun?.status === 'pending'

  const { data: repairSession, refetch: refetchRepair } = useGetRepairSessionByTaskQuery(taskExecutionId, {
    skip: !taskExecutionId,
    pollingInterval: 3000,
  })

  const { data: workspace, refetch: refetchWorkspace } = useGetWorkspaceQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 3000 },
  )

  // Phase 10 — publishing. Session id bootstraps the WebSocket; live progress
  // comes over usePublishingStream, not the poll.
  const { data: publishData, refetch: refetchPublish } = useGetPublishSessionQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 3000 },
  )
  const publishSession = publishData?.session ?? null
  const publishTerminal =
    publishSession != null &&
    ['completed', 'failed', 'cancelled'].includes(publishSession.status)
  const publishActive = publishSession != null && !publishTerminal

  const isPlanning = task?.status === 'planning' || task?.status === 'draft' || task?.status === 'plan_ready'
  const isPlanningLive = task?.status === 'planning' || task?.status === 'draft'

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
    enabled: Boolean(repoId && taskId) && execLive,
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

  // Only one phase streams at a time — its trailing work group stays expanded
  // in the thread; everything else defaults collapsed.
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
  const live = livePhase !== undefined

  // ── Actions ──────────────────────────────────────────────────────────────
  const [approve, { isLoading: approving }] = useApproveTaskMutation()
  const [replan, { isLoading: replanning }] = useReplanTaskMutation()
  const [refinePlan, { isLoading: refining }] = useRefinePlanMutation()
  const [followUp, { isLoading: followingUp }] = useFollowUpMutation()
  const { data: messagesData } = useListMissionMessagesQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )

  // ── Turn-aware artifact gating ────────────────────────────────────────────
  // After a follow-up message, artifacts (validation, repair, files, publish)
  // from the *previous* turn must NOT appear in the current turn. We compare
  // each artifact's created_at with the last user message's created_at.
  // If no follow-ups exist, everything belongs to the current (only) turn.
  const lastUserMsg = useMemo(() => {
    const userMsgs = (messagesData?.messages ?? [])
      .filter((m) => m.role === 'user' && m.turn_number > 1)
      .sort((a, b) => a.turn_number - b.turn_number)
    return userMsgs[userMsgs.length - 1]
  }, [messagesData?.messages])

  const lastUserMsgTime = lastUserMsg ? new Date(lastUserMsg.created_at).getTime() : 0

  /** True if the artifact was created AFTER the last follow-up (i.e. belongs to the current turn). */
  function belongsToCurrentTurn(createdAt: string | undefined): boolean {
    if (!lastUserMsg) return true // no follow-ups → single turn
    if (!createdAt) return false  // no timestamp → can't verify → hide
    return new Date(createdAt).getTime() > lastUserMsgTime
  }

  const valBelongsToCurrent = belongsToCurrentTurn(valRun?.created_at)
  const execBelongsToCurrent = belongsToCurrentTurn(execution?.started_at)
  const repairBelongsToCurrent = repairSession?.created_at
    ? belongsToCurrentTurn(repairSession.created_at)
    : !lastUserMsg // no session + no follow-ups → ok; no session + follow-ups → hide
  const publishBelongsToCurrent = publishSession?.created_at
    ? belongsToCurrentTurn(publishSession.created_at)
    : !lastUserMsg
  const planBelongsToCurrent = belongsToCurrentTurn(plan?.created_at)

  const conversation = useMemo(
    () =>
      buildConversation({
        intent: task?.intent ?? '',
        planning: planEvents,
        execution: execEvents,
        validation: valEvents,
        repair: repairEvents,
        publishing: pubEvents,
        plan: planBelongsToCurrent ? plan : null,
        fileChanges: execBelongsToCurrent ? fileChanges : [],
        validationStages: valBelongsToCurrent ? validationStages : [],
        validationOverall: valBelongsToCurrent ? valRun?.overall_result : undefined,
        repairAttempts: repairBelongsToCurrent ? repairAttempts : [],
        publishingSession: publishBelongsToCurrent ? publishSession : null,
        livePhase,
        messages: messagesData?.messages ?? [],
      }),
    [
      task?.intent, planEvents, execEvents, valEvents, repairEvents, pubEvents,
      plan, fileChanges, validationStages, valRun?.overall_result, repairAttempts,
      publishSession, livePhase, messagesData?.messages,
      valBelongsToCurrent, execBelongsToCurrent, repairBelongsToCurrent, publishBelongsToCurrent,
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
    try {
      // Plan OFF → the backend auto-runs this follow-up once its plan is ready.
      await followUp({ repoId, taskId, message: msg, auto_run: !planMode }).unwrap()
      refetchTask()
    } catch {
      setSentRefinements((prev) => prev.filter((n) => n !== msg))
      setRefineNote(msg)
      toast.error('Could not send follow-up')
    }
  }

  const dispatch = useAppDispatch()

  // Re-plan = start a completely fresh cycle. The backend wipes the previous
  // run's artifacts (execution/diffs/validation/repair/publishing); here we
  // clear the client-side event streams and refetch so the thread doesn't show
  // any of the old run while the new plan is generated.
  async function handleReplan() {
    setProceeded(false)
    const ok = await run(
      replan({ repoId, taskId }).unwrap(),
      'Re-planning — starting fresh',
      'Failed to re-plan',
    )
    setReplanConfirmOpen(false)
    if (ok === false) return
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
  const heroProgress = missionFailed || missionDone
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
      <button className={styles.back} onClick={() => navigate(ROUTES.root)}>
        <Icon name="chevronLeft" size={14} /> Missions
      </button>
      <span className={styles.crumb}>Mission</span>
      {live && (
        <span className={styles.liveDot}>
          <span />
          {liveHint ?? 'live'}
        </span>
      )}
      <div className={styles.headerRight}>
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
  const canStartNew = missionDone || missionFailed
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
    <div className={styles.composerBox}>
      <textarea
        className={styles.composerInput}
        value={refineNote}
        onChange={(e) => setRefineNote(e.target.value)}
        placeholder={composerPlaceholder}
        rows={2}
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
            leadingIcon={<Icon name={planMode ? 'chat' : 'play'} size={14} />}
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
  )

  return (
    <>
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
          // Only show optimistic sentRefinements that haven't been persisted yet
          // Server-persisted messages now render inline via buildConversation
          const serverMsgs = (messagesData?.messages ?? [])
            .filter((m) => m.role === 'user' && m.turn_number > 1)
            .map((m) => m.content)
          const serverSet = new Set(serverMsgs)
          const pending = sentRefinements.filter((r) => !serverSet.has(r))
          return pending
        })()}
        composer={composer}
      />
      <ConfirmDialog
        open={replanConfirmOpen}
        danger
        title="Re-plan from scratch?"
        confirmLabel="Yes, re-plan"
        cancelLabel="Keep current"
        loading={replanning}
        message={
          <>
            This starts a completely fresh cycle. The current run’s work — the plan,
            code changes, validation results, and any pull request created for it —
            will be discarded and <strong>cannot be recovered</strong>.
          </>
        }
        onConfirm={handleReplan}
        onCancel={() => setReplanConfirmOpen(false)}
      />
    </>
  )
}

export default TaskWorkspace
