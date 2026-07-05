import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LogViewer,
  PageHeader,
  StatusBadge,
  type LogLine,
} from '@/components/common'
import { ExecutionTimeline } from '@/features/execution/ExecutionTimeline'
import { StepDetailDrawer } from '@/features/execution/StepDetailDrawer'
import { WorkspaceStatusCard } from '@/features/execution/WorkspaceStatusCard'
import { useAppSelector } from '@/app/hooks'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useToast } from '@/hooks/useToast'
import { useGetTaskQuery } from '@/services/api/taskApi'
import {
  useCancelExecutionMutation,
  useGetExecutionDiffsQuery,
  useGetExecutionEventsQuery,
  useGetExecutionQuery,
  useStartExecutionMutation,
} from '@/services/api/executionApi'
import { useGetValidationQuery } from '@/services/api/validationApi'
import {
  EXECUTION_STATUS,
  VALIDATION_RUN_STATUS,
  VALIDATION_OVERALL_RESULT,
  resolveStatus,
} from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import type { StepExecution } from '@/types'
import styles from './Execution.module.css'

const LIVE = new Set(['pending', 'running'])

export function Execution() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  const [selectedStep, setSelectedStep] = useState<StepExecution | null>(null)

  const { data: taskData } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const task = taskData?.task

  const {
    data: snapshot,
    error: execError,
    refetch: refetchExec,
  } = useGetExecutionQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 0 },
  )
  const execution = snapshot?.execution
  const steps = useMemo(() => snapshot?.steps ?? [], [snapshot])
  const isLive = LIVE.has(execution?.status ?? '')

  const { data: diffs = [], refetch: refetchDiffs } = useGetExecutionDiffsQuery(
    { repoId, taskId },
    { skip: !execution },
  )
  const { data: events = [], refetch: refetchEvents } = useGetExecutionEventsQuery(
    { repoId, taskId },
    { skip: !execution },
  )

  // Poll validation status so the button reflects the current state
  const { data: valSnap, refetch: refetchVal } = useGetValidationQuery(
    { repoId, taskId },
    { skip: !execution || execution.status === 'running' || execution.status === 'pending' },
  )
  const valRun = valSnap?.run

  const [start, { isLoading: starting }] = useStartExecutionMutation()
  const [cancel, { isLoading: cancelling }] = useCancelExecutionMutation()

  // Live event stream while running.
  useSocketChannel({
    channel: 'execution',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/execution/stream`,
    enabled: Boolean(repoId && taskId) && isLive,
  })
  const live = useAppSelector((s) => s.stream.execution[taskId])

  // Refetch persisted state as the stream reports progress.
  const lastKind = live?.events[live.events.length - 1]?.kind
  useEffect(() => {
    if (!lastKind) return
    if (['step_complete', 'exec_complete', 'error', 'execution_error', 'plan_deviation'].includes(lastKind)) {
      refetchExec()
      refetchDiffs()
      refetchEvents()
    }
    // When execution completes, start polling validation (it auto-starts server-side).
    if (lastKind === 'exec_complete' || lastKind === 'validation_queued') {
      refetchVal()
    }
  }, [lastKind, live?.events.length, refetchExec, refetchDiffs, refetchEvents, refetchVal])

  const hasExecution = Boolean(execution)
  const notStarted =
    !hasExecution && execError && 'status' in execError && execError.status === 404

  const canStart =
    task?.approval_status === 'approved' && task?.status === 'plan_approved' && !hasExecution

  // Derive validation pill label and tone for the nav button.
  const valStatus = valRun?.overall_result ?? valRun?.status
  const valMeta = valStatus
    ? resolveStatus(
        valRun?.overall_result ? VALIDATION_OVERALL_RESULT : VALIDATION_RUN_STATUS,
        valStatus,
      )
    : null

  const logLines: LogLine[] = (live?.events ?? []).map((e) => ({
    id: e.seq,
    text: e.label,
    tone:
      e.kind === 'execution_error' || e.kind === 'error'
        ? 'error'
        : e.kind === 'step_complete' || e.kind === 'exec_complete'
          ? 'success'
          : e.kind === 'plan_deviation' || e.kind === 'requires_human'
            ? 'warning'
            : e.kind === 'validation_queued'
              ? 'info'
              : 'default',
  }))

  async function onStart() {
    try {
      await start({ repoId, taskId }).unwrap()
      toast.info('Execution started')
    } catch {
      toast.error('Failed to start execution')
    }
  }

  async function onCancel() {
    try {
      await cancel({ repoId, taskId }).unwrap()
      toast.info('Cancelling execution…')
    } catch {
      toast.error('Failed to cancel')
    }
  }

  const withRepo = (p: string) => `${p}?repo=${repoId}`

  // Execution is done (completed or completed_with_deviations or failed).
  const execDone =
    execution?.status === 'completed' ||
    execution?.status === 'completed_with_deviations' ||
    execution?.status === 'failed'

  return (
    <div className={styles.page}>
      <PageHeader
        breadcrumbs={[
          { label: 'Tasks', to: ROUTES.tasks },
          { label: 'Task', to: withRepo(routeTo.task(taskId)) },
          { label: 'Execution' },
        ]}
        title="Execution"
        description={task?.intent}
        actions={
          <>
            {execution && <StatusBadge map={EXECUTION_STATUS} status={execution.status} />}
            {execution?.status === 'running' && (
              <Button variant="danger" onClick={onCancel} loading={cancelling} leadingIcon={<Icon name="x" size={15} />}>
                Cancel
              </Button>
            )}
            {/* Validation button — navigates to the report. Never triggers validation.
                Shows validation status inline so the user knows the pipeline result. */}
            {execDone && (
              <Button
                variant="secondary"
                leadingIcon={<Icon name="task" size={15} />}
                onClick={() => navigate(withRepo(routeTo.taskValidation(taskId)))}
              >
                {valMeta ? (
                  <>Validation — {valMeta.label}</>
                ) : valRun?.status === 'running' ? (
                  <>Validation — Running…</>
                ) : (
                  <>View validation</>
                )}
              </Button>
            )}
            {canStart && (
              <Button variant="primary" onClick={onStart} loading={starting} leadingIcon={<Icon name="play" size={15} />}>
                Start execution
              </Button>
            )}
          </>
        }
      />

      {!hasExecution ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            icon={<Icon name="execution" size={40} />}
            title={canStart ? 'Ready to execute' : notStarted ? 'Not started' : 'Execution unavailable'}
            description={
              canStart
                ? 'Start execution to run the approved plan in an isolated workspace.'
                : 'The plan must be approved before execution can begin.'
            }
            action={
              canStart ? (
                <Button variant="primary" onClick={onStart} loading={starting}>
                  Start execution
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => navigate(withRepo(routeTo.taskPlan(taskId)))}>
                  Review plan
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.left}>
            <Card padded={false}>
              <CardHeader
                title="Steps"
                subtitle={`${steps.filter((s) => s.status === 'completed').length}/${steps.length} complete`}
              />
              <div className={styles.timeline}>
                {steps.length === 0 ? (
                  <div className={styles.preparing}>Preparing steps…</div>
                ) : (
                  <ExecutionTimeline
                    steps={steps}
                    currentStepStableId={execution?.current_step_stable_id}
                    selectedId={selectedStep?.id}
                    onSelect={setSelectedStep}
                  />
                )}
              </div>
            </Card>

            <WorkspaceStatusCard repoId={repoId} taskId={taskId} />
          </div>

          <div className={styles.right}>
            <Card padded={false}>
              <CardHeader title="Live activity" />
              <div className={styles.log}>
                <LogViewer
                  lines={logLines}
                  live={execution?.status === 'running'}
                  maxHeight={260}
                  emptyLabel={execution?.status === 'running' ? 'Waiting for events…' : 'No live events. Open a step for its recorded trace.'}
                />
              </div>
            </Card>

            <Card padded={false}>
              <CardHeader
                title="Modified files"
                actions={
                  diffs.length > 0 ? (
                    <span className={styles.diffTotals}>
                      <span className={styles.add}>+{diffs.reduce((a, d) => a + d.lines_added, 0)}</span>{' '}
                      <span className={styles.del}>-{diffs.reduce((a, d) => a + d.lines_removed, 0)}</span>
                    </span>
                  ) : undefined
                }
              />
              <div className={styles.files}>
                {diffs.length === 0 ? (
                  <div className={styles.preparing}>No file changes yet.</div>
                ) : (
                  diffs.map((d) => (
                    <div key={d.id} className={styles.fileRow}>
                      <span className={styles.op} data-op={d.operation}>{d.operation}</span>
                      <code className={styles.filePath}>{d.file_path}</code>
                      <span className={styles.fileStat}>
                        <span className={styles.add}>+{d.lines_added}</span>{' '}
                        <span className={styles.del}>-{d.lines_removed}</span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      <StepDetailDrawer
        step={selectedStep}
        events={events}
        diffs={diffs}
        onClose={() => setSelectedStep(null)}
      />
    </div>
  )
}

export default Execution

// const LIVE = new Set(['pending', 'running'])

// export function Execution() {
//   const { id: taskId = '' } = useParams()
//   const [params] = useSearchParams()
//   const repoId = params.get('repo') ?? ''
//   const navigate = useNavigate()
//   const toast = useToast()

//   const [selectedStep, setSelectedStep] = useState<StepExecution | null>(null)

//   const { data: taskData } = useGetTaskQuery(
//     { repoId, taskId },
//     { skip: !repoId || !taskId },
//   )
//   const task = taskData?.task

//   const {
//     data: snapshot,
//     error: execError,
//     refetch: refetchExec,
//   } = useGetExecutionQuery(
//     { repoId, taskId },
//     { skip: !repoId || !taskId, pollingInterval: 0 },
//   )
//   const execution = snapshot?.execution
//   const steps = useMemo(() => snapshot?.steps ?? [], [snapshot])
//   const isLive = LIVE.has(execution?.status ?? '')

//   const { data: diffs = [], refetch: refetchDiffs } = useGetExecutionDiffsQuery(
//     { repoId, taskId },
//     { skip: !execution },
//   )
//   const { data: events = [], refetch: refetchEvents } = useGetExecutionEventsQuery(
//     { repoId, taskId },
//     { skip: !execution },
//   )

//   const [start, { isLoading: starting }] = useStartExecutionMutation()
//   const [cancel, { isLoading: cancelling }] = useCancelExecutionMutation()

//   // Live event stream while running.
//   useSocketChannel({
//     channel: 'execution',
//     resourceId: taskId,
//     path: `/repos/${repoId}/tasks/${taskId}/execution/stream`,
//     enabled: Boolean(repoId && taskId) && isLive,
//   })
//   const live = useAppSelector((s) => s.stream.execution[taskId])

//   // Refetch persisted state as the stream reports progress.
//   const lastKind = live?.events[live.events.length - 1]?.kind
//   useEffect(() => {
//     if (!lastKind) return
//     if (['step_complete', 'exec_complete', 'error', 'execution_error', 'plan_deviation'].includes(lastKind)) {
//       refetchExec()
//       refetchDiffs()
//       refetchEvents()
//     }
//   }, [lastKind, live?.events.length, refetchExec, refetchDiffs, refetchEvents])

//   const hasExecution = Boolean(execution)
//   const notStarted =
//     !hasExecution && execError && 'status' in execError && execError.status === 404

//   const canStart =
//     task?.approval_status === 'approved' && task?.status === 'plan_approved' && !hasExecution

//   const logLines: LogLine[] = (live?.events ?? []).map((e) => ({
//     id: e.seq,
//     text: e.label,
//     tone:
//       e.kind === 'execution_error' || e.kind === 'error'
//         ? 'error'
//         : e.kind === 'step_complete' || e.kind === 'exec_complete'
//           ? 'success'
//           : e.kind === 'plan_deviation' || e.kind === 'requires_human'
//             ? 'warning'
//             : 'default',
//   }))

//   async function onStart() {
//     try {
//       await start({ repoId, taskId }).unwrap()
//       toast.info('Execution started')
//     } catch {
//       toast.error('Failed to start execution')
//     }
//   }

//   async function onCancel() {
//     try {
//       await cancel({ repoId, taskId }).unwrap()
//       toast.info('Cancelling execution…')
//     } catch {
//       toast.error('Failed to cancel')
//     }
//   }

//   const withRepo = (p: string) => `${p}?repo=${repoId}`

//   return (
//     <div className={styles.page}>
//       <PageHeader
//         breadcrumbs={[
//           { label: 'Tasks', to: ROUTES.tasks },
//           { label: 'Task', to: withRepo(routeTo.task(taskId)) },
//           { label: 'Execution' },
//         ]}
//         title="Execution"
//         description={task?.intent}
//         actions={
//           <>
//             {execution && <StatusBadge map={EXECUTION_STATUS} status={execution.status} />}
//             {execution?.status === 'running' && (
//               <Button variant="danger" onClick={onCancel} loading={cancelling} leadingIcon={<Icon name="x" size={15} />}>
//                 Cancel
//               </Button>
//             )}
//             {(execution?.status === 'completed' || execution?.status === 'failed') && (
//               <Button
//                 variant="secondary"
//                 leadingIcon={<Icon name="task" size={15} />}
//                 onClick={() => navigate(withRepo(routeTo.taskValidation(taskId)))}
//               >
//                 Validation
//               </Button>
//             )}
//             {canStart && (
//               <Button variant="primary" onClick={onStart} loading={starting} leadingIcon={<Icon name="play" size={15} />}>
//                 Start execution
//               </Button>
//             )}
//           </>
//         }
//       />

//       {!hasExecution ? (
//         <div className={styles.emptyWrap}>
//           <EmptyState
//             icon={<Icon name="execution" size={40} />}
//             title={canStart ? 'Ready to execute' : notStarted ? 'Not started' : 'Execution unavailable'}
//             description={
//               canStart
//                 ? 'Start execution to run the approved plan in an isolated workspace.'
//                 : 'The plan must be approved before execution can begin.'
//             }
//             action={
//               canStart ? (
//                 <Button variant="primary" onClick={onStart} loading={starting}>
//                   Start execution
//                 </Button>
//               ) : (
//                 <Button variant="secondary" onClick={() => navigate(withRepo(routeTo.taskPlan(taskId)))}>
//                   Review plan
//                 </Button>
//               )
//             }
//           />
//         </div>
//       ) : (
//         <div className={styles.body}>
//           <div className={styles.left}>
//             <Card padded={false}>
//               <CardHeader
//                 title="Steps"
//                 subtitle={`${steps.filter((s) => s.status === 'completed').length}/${steps.length} complete`}
//               />
//               <div className={styles.timeline}>
//                 {steps.length === 0 ? (
//                   <div className={styles.preparing}>Preparing steps…</div>
//                 ) : (
//                   <ExecutionTimeline
//                     steps={steps}
//                     currentStepStableId={execution?.current_step_stable_id}
//                     selectedId={selectedStep?.id}
//                     onSelect={setSelectedStep}
//                   />
//                 )}
//               </div>
//             </Card>

//             <WorkspaceStatusCard repoId={repoId} taskId={taskId} />
//           </div>

//           <div className={styles.right}>
//             <Card padded={false}>
//               <CardHeader title="Live activity" />
//               <div className={styles.log}>
//                 <LogViewer
//                   lines={logLines}
//                   live={execution?.status === 'running'}
//                   maxHeight={260}
//                   emptyLabel={execution?.status === 'running' ? 'Waiting for events…' : 'No live events. Open a step for its recorded trace.'}
//                 />
//               </div>
//             </Card>

//             <Card padded={false}>
//               <CardHeader
//                 title="Modified files"
//                 actions={
//                   diffs.length > 0 ? (
//                     <span className={styles.diffTotals}>
//                       <span className={styles.add}>+{diffs.reduce((a, d) => a + d.lines_added, 0)}</span>{' '}
//                       <span className={styles.del}>-{diffs.reduce((a, d) => a + d.lines_removed, 0)}</span>
//                     </span>
//                   ) : undefined
//                 }
//               />
//               <div className={styles.files}>
//                 {diffs.length === 0 ? (
//                   <div className={styles.preparing}>No file changes yet.</div>
//                 ) : (
//                   diffs.map((d) => (
//                     <div key={d.id} className={styles.fileRow}>
//                       <span className={styles.op} data-op={d.operation}>{d.operation}</span>
//                       <code className={styles.filePath}>{d.file_path}</code>
//                       <span className={styles.fileStat}>
//                         <span className={styles.add}>+{d.lines_added}</span>{' '}
//                         <span className={styles.del}>-{d.lines_removed}</span>
//                       </span>
//                     </div>
//                   ))
//                 )}
//               </div>
//             </Card>
//           </div>
//         </div>
//       )}

//       <StepDetailDrawer
//         step={selectedStep}
//         events={events}
//         diffs={diffs}
//         onClose={() => setSelectedStep(null)}
//       />
//     </div>
//   )
// }

// export default Execution
