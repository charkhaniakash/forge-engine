import { useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LogViewer,
  PageHeader,
  Spinner,
  StatusBadge,
  type LogLine,
} from '@/components/common'
import { useAppSelector } from '@/app/hooks'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useGetTaskQuery } from '@/services/api/taskApi'
import {
  APPROVAL_STATUS,
  EXECUTION_STATUS,
  WORK_ITEM_STATUS,
} from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './Task.module.css'

const PLANNING_STATES = new Set(['planning', 'draft'])

export function Task() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()

  const { data, isLoading, refetch } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const task = data?.task
  const plan = data?.plan
  const isPlanning = PLANNING_STATES.has(task?.status ?? '')

  useSocketChannel({
    channel: 'planning',
    resourceId: taskId,
    path: `/repos/${repoId}/tasks/${taskId}/stream`,
    enabled: Boolean(repoId && taskId) && isPlanning,
  })
  const planningStream = useAppSelector((s) => s.stream.planning[taskId])

  // When planning emits a terminal event, pull the finished plan.
  const lastEvent = planningStream?.events[planningStream.events.length - 1]?.event
  useEffect(() => {
    if (lastEvent && ['plan', 'plan_ready', 'error', 'done'].includes(lastEvent)) {
      refetch()
    }
  }, [lastEvent, refetch])

  const planningLog: LogLine[] = (planningStream?.events ?? []).map((ev, i) => ({
    id: i,
    text: ev.stage ? `[${ev.stage}] ${ev.message ?? ev.event}` : ev.message ?? ev.event,
    tone: ev.event === 'error' ? 'error' : 'info',
  }))

  if (!repoId) {
    return (
      <EmptyState
        icon={<Icon name="alert" size={32} />}
        title="Missing repository context"
        description="Open this task from the Tasks list."
        action={<Button variant="secondary" onClick={() => navigate(ROUTES.tasks)}>Go to Tasks</Button>}
      />
    )
  }

  if (isLoading) {
    return (
      <div className={styles.body}>
        <Spinner size={20} />
      </div>
    )
  }

  if (!task) {
    return (
      <EmptyState
        icon={<Icon name="task" size={32} />}
        title="Task not found"
        action={<Button variant="secondary" onClick={() => navigate(ROUTES.tasks)}>Back to Tasks</Button>}
      />
    )
  }

  const withRepo = (path: string) => `${path}?repo=${repoId}`

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Tasks', to: ROUTES.tasks },
          { label: 'Task' },
        ]}
        title="Task"
        actions={
          <>
            <Button
              variant="secondary"
              leadingIcon={<Icon name="file" size={15} />}
              onClick={() => navigate(withRepo(routeTo.taskPlan(taskId)))}
              disabled={!plan}
            >
              Review plan
            </Button>
            <Button
              variant="primary"
              leadingIcon={<Icon name="execution" size={15} />}
              onClick={() => navigate(withRepo(routeTo.taskExecution(taskId)))}
              disabled={task.approval_status !== 'approved' && task.status !== 'executing' && task.status !== 'done'}
            >
              Execution
            </Button>
          </>
        }
      />

      <div className={styles.body}>
        <Card>
          <CardHeader
            title="Description"
            actions={
              <div className={styles.badges}>
                <StatusBadge map={WORK_ITEM_STATUS} status={task.status} />
                <StatusBadge map={APPROVAL_STATUS} status={task.approval_status} dot={false} size="sm" />
              </div>
            }
          />
          <p className={styles.intent}>{task.intent}</p>
          {task.error && <div className={styles.error}>{task.error}</div>}
        </Card>

        <div className={styles.grid}>
          <Card padded={false}>
            <CardHeader title="Planning" />
            <div className={styles.section}>
              {isPlanning ? (
                <>
                  <div className={styles.planningHead}>
                    <Spinner size={14} />
                    <span>Drafting implementation plan…</span>
                  </div>
                  <LogViewer lines={planningLog} live maxHeight={180} emptyLabel="Waiting for planner…" />
                </>
              ) : plan ? (
                <div className={styles.stat}>
                  <div>
                    <div className={styles.statValue}>{plan.body.steps.length}</div>
                    <div className={styles.statLabel}>steps</div>
                  </div>
                  <div>
                    <div className={styles.statValue}>{plan.body.affected_files.length}</div>
                    <div className={styles.statLabel}>files</div>
                  </div>
                  <div>
                    <div className={styles.statValue}>v{plan.version}</div>
                    <div className={styles.statLabel}>plan</div>
                  </div>
                </div>
              ) : (
                <div className={styles.muted}>No plan available.</div>
              )}
            </div>
          </Card>

          <Card padded={false}>
            <CardHeader title="Execution" />
            <div className={styles.section}>
              <div className={styles.row}>
                <span>Status</span>
                <StatusBadge map={EXECUTION_STATUS} status={task.status === 'executing' ? 'running' : task.status === 'done' ? 'completed' : 'pending'} />
              </div>
              <div className={styles.row}>
                <span>Workspace</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(withRepo(routeTo.taskWorkspace(taskId)))}
                >
                  View <Icon name="chevronRight" size={13} />
                </Button>
              </div>
            </div>
          </Card>
        </div>

        {plan && (
          <Card>
            <CardHeader title="Plan summary" subtitle={plan.body.intent_summary} />
            {plan.body.risks.length > 0 && (
              <div className={styles.risks}>
                {plan.body.risks.map((r, i) => (
                  <Badge key={i} tone={r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warning' : 'neutral'} size="sm">
                    {r.severity}: {r.description.slice(0, 60)}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}

export default Task
