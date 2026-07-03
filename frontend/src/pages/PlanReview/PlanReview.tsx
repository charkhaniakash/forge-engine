import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Icon,
  PageHeader,
  Spinner,
} from '@/components/common'
import { PlanStepCard } from '@/features/planning/PlanStepCard'
import { ApprovalPanel } from '@/features/planning/ApprovalPanel'
import {
  useApproveTaskMutation,
  useCancelTaskMutation,
  useGetTaskQuery,
  useReplanTaskMutation,
} from '@/services/api/taskApi'
import { useToast } from '@/hooks/useToast'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './PlanReview.module.css'

export function PlanReview() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  const { data, isLoading } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId },
  )
  const [approve, { isLoading: approving }] = useApproveTaskMutation()
  const [cancel, { isLoading: rejecting }] = useCancelTaskMutation()
  const [replan, { isLoading: replanning }] = useReplanTaskMutation()
  const [confirmReject, setConfirmReject] = useState(false)

  const task = data?.task
  const plan = data?.plan
  const body = plan?.body
  const withRepo = (p: string) => `${p}?repo=${repoId}`

  async function onApprove() {
    try {
      await approve({ repoId, taskId }).unwrap()
      toast.success('Plan approved', { message: 'You can now start execution.' })
      navigate(withRepo(routeTo.taskExecution(taskId)))
    } catch {
      toast.error('Failed to approve plan')
    }
  }

  async function onReject() {
    try {
      await cancel({ repoId, taskId }).unwrap()
      toast.info('Plan rejected')
      setConfirmReject(false)
    } catch {
      toast.error('Failed to reject')
    }
  }

  async function onReplan() {
    try {
      await replan({ repoId, taskId }).unwrap()
      toast.info('Re-planning started')
      navigate(withRepo(routeTo.task(taskId)))
    } catch {
      toast.error('Failed to re-plan')
    }
  }

  if (isLoading) {
    return <div className={styles.center}><Spinner size={20} /></div>
  }

  if (!task || !body) {
    return (
      <EmptyState
        icon={<Icon name="file" size={32} />}
        title="No plan to review"
        description="The plan may still be generating."
        action={
          <Button variant="secondary" onClick={() => navigate(withRepo(routeTo.task(taskId)))}>
            Back to task
          </Button>
        }
      />
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.scroll}>
        <PageHeader
          breadcrumbs={[
            { label: 'Tasks', to: ROUTES.tasks },
            { label: 'Task', to: withRepo(routeTo.task(taskId)) },
            { label: 'Plan review' },
          ]}
          title="Plan review"
          description={task.intent}
        />

        <div className={styles.body}>
          <Section title="Overview" icon="file">
            <p className={styles.prose}>{body.intent_summary}</p>
            <div className={styles.metrics}>
              <Metric value={body.steps.length} label="Steps" />
              <Metric value={body.affected_files.length} label="Affected files" />
              <Metric value={body.risks.length} label="Risks" />
              <Metric value={`v${plan.version}`} label="Version" />
            </div>
          </Section>

          <Section title="Architecture impact" icon="workspace">
            {body.assumptions.length === 0 ? (
              <p className={styles.muted}>No architectural assumptions recorded.</p>
            ) : (
              <ul className={styles.assumptions}>
                {body.assumptions.map((a, i) => (
                  <li key={i}>
                    <Icon name={a.user_verified ? 'check' : 'dot'} size={14} />
                    <span>{a.description}</span>
                    {a.user_verified && <Badge tone="success" size="sm">verified</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Implementation steps" icon="task">
            <div className={styles.steps}>
              {body.steps.map((step, i) => (
                <PlanStepCard key={step.id} step={step} index={i} />
              ))}
            </div>
          </Section>

          <Section title="Affected files" icon="file">
            <div className={styles.fileList}>
              {body.affected_files.map((f) => (
                <div key={f.path} className={styles.fileRow}>
                  <Badge tone="neutral" size="sm">{f.change_type}</Badge>
                  <code className={styles.filePath}>{f.path}</code>
                  <span className={styles.fileRationale}>{f.rationale}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Risk" icon="alert">
            {body.risks.length === 0 ? (
              <p className={styles.muted}>No significant risks identified.</p>
            ) : (
              <div className={styles.risks}>
                {body.risks.map((r, i) => (
                  <div key={i} className={styles.riskRow}>
                    <Badge
                      tone={r.severity === 'high' ? 'danger' : r.severity === 'medium' ? 'warning' : 'neutral'}
                      size="sm"
                    >
                      {r.severity}
                    </Badge>
                    <span>{r.description}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      <ApprovalPanel
        approvalStatus={task.approval_status}
        canApprove={task.status === 'plan_ready'}
        approving={approving}
        rejecting={rejecting}
        replanning={replanning}
        onApprove={onApprove}
        onReject={() => setConfirmReject(true)}
        onReplan={onReplan}
      />

      <ConfirmDialog
        open={confirmReject}
        title="Reject this plan?"
        message="The task will be cancelled. You can re-plan to try again."
        confirmLabel="Reject"
        danger
        loading={rejecting}
        onConfirm={onReject}
        onCancel={() => setConfirmReject(false)}
      />
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: Parameters<typeof Icon>[0]['name']
  children: React.ReactNode
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        <Icon name={icon} size={16} /> {title}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function Metric({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricValue}>{value}</div>
      <div className={styles.metricLabel}>{label}</div>
    </div>
  )
}

export default PlanReview
