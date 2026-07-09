import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Spinner,
  StatusBadge,
} from '@/components/common'
import {
  MissionView,
  ValidationStages,
  RepairAttemptCard,
  FileChanges,
  type LifecyclePhase,
} from '@/features/task-workspace'
import { PlanStepCard } from '@/features/planning/PlanStepCard'
import { useRepairStream } from '@/features/task-workspace/useRepairStream'
import {
  buildActivity,
  buildFileChanges,
  buildPhases,
  buildRepairAttempts,
  buildValidationStages,
  defaultActivePhaseKey,
} from '@/features/task-workspace/normalize'
import { useAppSelector } from '@/app/hooks'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useToast } from '@/hooks/useToast'
import {
  useApproveTaskMutation,
  useCancelTaskMutation,
  useGetTaskQuery,
  useReplanTaskMutation,
} from '@/services/api/taskApi'
import {
  useCancelExecutionMutation,
  useGetExecutionDiffsQuery,
  useGetExecutionQuery,
  useStartExecutionMutation,
} from '@/services/api/executionApi'
import {
  useGetValidationQuery,
  useStartValidationMutation,
} from '@/services/api/validationApi'
import { useGetRepairSessionByTaskQuery } from '@/services/api/repairApi'
import {
  useGetWorkspaceQuery,
  useProvisionWorkspaceMutation,
} from '@/services/api/workspaceApi'
import {
  useGetPublishSessionQuery,
  useStartPublishMutation,
} from '@/services/api/publishingApi'
import { usePublishingStream } from '@/features/task-workspace/usePublishingStream'
import { APPROVAL_STATUS, PUBLISHING_STATUS, WORK_ITEM_STATUS } from '@/constants/status'
import { ROUTES } from '@/constants/routes'
import styles from './TaskWorkspace.module.css'

const EXEC_LIVE = new Set(['pending', 'running'])

export function TaskWorkspace() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  // ── Data ────────────────────────────────────────────────────────────────
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
  const activity = useMemo(
    () => buildActivity({ planning: planEvents, execution: execEvents, validation: valEvents, repair: repairEvents, publishing: pubEvents }),
    [planEvents, execEvents, valEvents, repairEvents, pubEvents],
  )
  const phases = useMemo<LifecyclePhase[]>(() => {
    if (!task) return []
    return buildPhases({
      task,
      hasPlan: Boolean(plan),
      execution: execSnap,
      validation: valRun,
      validationStages,
      repairSession,
      repairAttempts,
      publishingSession: publishSession,
    })
  }, [task, plan, execSnap, valRun, validationStages, repairSession, repairAttempts, publishSession])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const activeKey = selectedKey ?? defaultActivePhaseKey(phases)
  const live = isPlanningLive || execLive || Boolean(valLiveState) || repairSession?.status === 'running' || publishActive

  // Scroll a section into view when the user picks a phase. Query at click time
  // (event handler) rather than holding render-time refs.
  function onSelectPhase(p: LifecyclePhase) {
    const key = p.attempt != null ? `${p.kind}-${p.attempt}` : p.kind
    setSelectedKey(key)
    document
      .querySelector(`[data-phase="${p.kind}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  const [approve, { isLoading: approving }] = useApproveTaskMutation()
  const [replan, { isLoading: replanning }] = useReplanTaskMutation()
  const [cancel] = useCancelTaskMutation()
  const [startExec, { isLoading: starting }] = useStartExecutionMutation()
  const [cancelExec] = useCancelExecutionMutation()
  const [startValidation, { isLoading: validating }] = useStartValidationMutation()
  const [provisionWorkspace, { isLoading: provisioning }] = useProvisionWorkspaceMutation()
  const [startPublish, { isLoading: publishStarting }] = useStartPublishMutation()

  async function run<T>(p: Promise<T>, ok: string, err: string) {
    try {
      await p
      toast.success(ok)
    } catch {
      toast.error(err)
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
  const needsWorkspace = approved && status === 'plan_approved' && (!workspace || !workspaceReady)
  const canExecute = approved && status === 'plan_approved' && workspaceReady && !execution
  const isExecuting = execStatus === 'running' || execStatus === 'pending'
  const execDone = execStatus === 'completed'
  const canValidate = execDone && !valRun && !validating
  const missionDone = status === 'done' || overall === 'passed'
  const missionFailed = status === 'failed' || status === 'cancelled'
  const prUrl = publishSession?.status === 'completed' ? publishSession.pr_url : null

  const actions: React.ReactNode[] = []
  if (canApprove) {
    actions.push(
      <Button key="replan" variant="ghost" loading={replanning}
        onClick={() => run(replan({ repoId, taskId }).unwrap(), 'Re-planning', 'Failed to re-plan')}>
        Edit / Re-plan
      </Button>,
      <Button key="reject" variant="danger"
        onClick={() => run(cancel({ repoId, taskId }).unwrap(), 'Plan rejected', 'Failed to reject')}>
        Reject
      </Button>,
      <Button key="approve" variant="primary" loading={approving || provisioning || starting} leadingIcon={<Icon name="check" size={15} />}
        onClick={async () => {
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
        }}>
        Approve &amp; run
      </Button>,
    )
  } else if (needsWorkspace) {
    actions.push(
      <Button key="provision" variant="primary" loading={provisioning} leadingIcon={<Icon name="play" size={15} />}
        onClick={async () => {
          await run(provisionWorkspace({ repoId, taskId }).unwrap(), 'Workspace provisioning', 'Failed to provision workspace')
          refetchWorkspace()
          refetchTask()
        }}>
        Provision workspace
      </Button>,
    )
  } else if (canExecute) {
    actions.push(
      <Button key="exec" variant="primary" loading={starting} leadingIcon={<Icon name="play" size={15} />}
        onClick={() => run(startExec({ repoId, taskId }).unwrap(), 'Execution started', 'Failed to start')}>
        Start execution
      </Button>,
    )
  } else if (isExecuting) {
    actions.push(
      <Button key="cancel" variant="danger" leadingIcon={<Icon name="x" size={15} />}
        onClick={() => run(cancelExec({ repoId, taskId }).unwrap(), 'Cancelling…', 'Failed to cancel')}>
        Cancel execution
      </Button>,
    )
  } else if (canValidate) {
    actions.push(
      <Button key="validate" variant="primary" loading={validating} leadingIcon={<Icon name="check" size={15} />}
        onClick={() => run(startValidation({ repoId, taskId }).unwrap(), 'Validation started', 'Failed to validate')}>
        Run validation
      </Button>,
    )
  } else if (missionDone && !isExecuting && !repairing) {
    // Validation passed (or repair succeeded) → the next step is shipping it.
    if (prUrl) {
      actions.push(
        <a key="pr" className={styles.prLink} href={prUrl} target="_blank" rel="noreferrer">
          <Icon name="git" size={15} /> View pull request
          {publishSession?.pr_number ? ` #${publishSession.pr_number}` : ''}
        </a>,
      )
    } else if (publishActive) {
      // handled by the live "Publishing…" chip below
    } else if (!publishSession || publishSession.status === 'failed' || publishSession.status === 'cancelled') {
      actions.push(
        <Button key="publish" variant="primary" loading={publishStarting}
          leadingIcon={<Icon name="git" size={15} />}
          onClick={async () => {
            await run(startPublish({ repoId, taskId }).unwrap(),
              'Publishing to GitHub…',
              'Failed to start publishing')
            refetchPublish()
            refetchTask()
          }}>
          {publishSession?.status === 'failed' ? 'Retry publish' : 'Publish to GitHub'}
        </Button>,
      )
    }
  } else if (missionFailed) {
    actions.push(
      <Button key="retry" variant="primary" loading={replanning} leadingIcon={<Icon name="refresh" size={15} />}
        onClick={() => run(replan({ repoId, taskId }).unwrap(), 'Re-planning', 'Failed to re-plan')}>
        Re-plan &amp; retry
      </Button>,
    )
  }

  // A live phase drives itself — surface what it's doing, not a dead end.
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

  const header = (
    <div className={styles.header}>
      <div className={styles.headerMain}>
        <button className={styles.back} onClick={() => navigate(ROUTES.root)}>
          <Icon name="chevronLeft" size={14} /> Missions
        </button>
        <h1 className={styles.intent}>{task.intent}</h1>
        <div className={styles.badges}>
          <StatusBadge map={WORK_ITEM_STATUS} status={task.status} />
          <StatusBadge map={APPROVAL_STATUS} status={task.approval_status} dot={false} size="sm" />
          {live && (
            <span className={styles.liveDot}>
              <span />
              {liveHint ?? 'live'}
            </span>
          )}
        </div>
      </div>
      <div className={styles.actions}>
        {actions.length > 0 ? (
          actions
        ) : liveHint ? (
          <span className={styles.waitChip}>
            <Spinner size={14} /> {liveHint}
          </span>
        ) : missionDone ? (
          <span className={styles.doneChip}>
            <Icon name="check" size={15} /> {prUrl ? 'Published' : 'Mission complete'}
          </span>
        ) : null}
      </div>
    </div>
  )

  const detail = (
    <>
      {plan && (
        <section data-phase="planning" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="file" size={16} /> Plan</h2>
          <p className={styles.summary}>{plan.body.intent_summary}</p>
          <div className={styles.steps}>
            {plan.body.steps.map((step, i) => (
              <PlanStepCard key={step.id} step={step} index={i} />
            ))}
          </div>
        </section>
      )}

      {execution && (execSnap?.steps.length ?? 0) > 0 && (
        <section data-phase="executing" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="execution" size={16} /> Execution steps</h2>
          <div className={styles.stepStatuses}>
            {execSnap!.steps.map((s) => (
              <div key={s.id} className={styles.stepRow} data-status={s.status}>
                <span className={styles.stepIdx}>#{s.step_order}</span>
                <span className={styles.stepName}>{s.step_stable_id}</span>
                <Badge tone={s.status === 'completed' ? 'success' : s.status === 'failed' ? 'danger' : s.status === 'running' ? 'info' : 'neutral'} size="sm">
                  {s.status}
                </Badge>
              </div>
            ))}
          </div>
        </section>
      )}

      {fileChanges.length > 0 && (
        <section data-phase="executing" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="code" size={16} /> Code changes</h2>
          <FileChanges files={fileChanges} />
        </section>
      )}

      {validationStages.length > 0 && (
        <section data-phase="validation" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="check" size={16} /> Validation</h2>
          <ValidationStages stages={validationStages} />
        </section>
      )}

      {repairAttempts.length > 0 && (
        <section data-phase="repair" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="repair" size={16} /> Repair</h2>
          <div className={styles.repairs}>
            {repairAttempts.map((a) => (
              <RepairAttemptCard key={a.attempt} attempt={a} />
            ))}
          </div>
        </section>
      )}

      {publishSession && (
        <section data-phase="publishing" className={styles.section}>
          <h2 className={styles.sectionTitle}><Icon name="git" size={16} /> Publishing</h2>
          <Card>
            <div className={styles.pubRow}>
              <span className={styles.pubLabel}>Status</span>
              <StatusBadge map={PUBLISHING_STATUS} status={publishSession.status} dot />
            </div>
            {publishSession.branch_name && (
              <div className={styles.pubRow}>
                <span className={styles.pubLabel}>Branch</span>
                <code className={styles.pubMono}>
                  <Icon name="branch" size={12} /> {publishSession.branch_name}
                </code>
              </div>
            )}
            {publishSession.draft_mode && (
              <div className={styles.pubRow}>
                <span className={styles.pubLabel}>Mode</span>
                <Badge tone="neutral" size="sm">Draft PR</Badge>
              </div>
            )}
            {prUrl && (
              <div className={styles.pubRow}>
                <span className={styles.pubLabel}>Pull request</span>
                <a className={styles.prLink} href={prUrl} target="_blank" rel="noreferrer">
                  <Icon name="externalLink" size={14} /> {prUrl.replace(/^https?:\/\//, '')}
                </a>
              </div>
            )}
            {publishSession.status === 'failed' && publishSession.error_message && (
              <div className={styles.pubError}>{publishSession.error_message}</div>
            )}
          </Card>
        </section>
      )}

      {!plan && !execution && (
        <Card>
          <EmptyState
            compact
            icon={<Icon name="task" size={28} />}
            title={task.status === 'planning' ? 'Planning in progress' : 'Nothing running yet'}
            description="Live activity will appear on the right as the agent works."
          />
        </Card>
      )}
    </>
  )

  // Split the one normalized stream into the reasoning feed (left) and the
  // tool-activity feed (right). Both are pure projections of backend events.
  const reasoningFeed = activity.filter((e) =>
    e.kind === 'reasoning' || e.kind === 'status' || e.kind === 'repair' || e.kind === 'error',
  )
  const toolFeed = activity.filter((e) =>
    e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'validation' || e.kind === 'diff',
  )

  const metrics = (
    <>
      {(execSnap?.steps.length ?? 0) > 0 && (
        <Badge tone="neutral" size="sm">
          {execSnap!.steps.filter((s) => s.status === 'completed').length}/{execSnap!.steps.length} steps
        </Badge>
      )}
      {validationStages.length > 0 && (
        <Badge tone="neutral" size="sm">
          {validationStages.filter((s) => s.state === 'passed').length}/{validationStages.length} stages
        </Badge>
      )}
      {fileChanges.length > 0 && <Badge tone="neutral" size="sm">{fileChanges.length} files</Badge>}
      {repairAttempts.length > 0 && (
        <Badge tone="warning" size="sm">{repairAttempts.length} repair {repairAttempts.length === 1 ? 'attempt' : 'attempts'}</Badge>
      )}
    </>
  )

  return (
    <MissionView
      header={header}
      phases={phases}
      activePhaseKey={activeKey}
      onSelectPhase={onSelectPhase}
      detail={detail}
      reasoning={reasoningFeed}
      tools={toolFeed}
      metrics={metrics}
      live={Boolean(live)}
    />
  )
}

export default TaskWorkspace
