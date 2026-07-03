import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Button,
  Card,
  EmptyState,
  Icon,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '@/components/common'
import {
  useCreateTaskMutation,
  useListTasksQuery,
} from '@/services/api/taskApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { useToast } from '@/hooks/useToast'
import { APPROVAL_STATUS, WORK_ITEM_STATUS } from '@/constants/status'
import { routeTo } from '@/constants/routes'
import styles from './Tasks.module.css'

export function Tasks() {
  const [params, setParams] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const toast = useToast()

  const { data: repos, isLoading: reposLoading } = useListReposQuery()

  if (!repoId) {
    return (
      <RepoPicker
        loading={reposLoading}
        repos={repos ?? []}
        onPick={(id) => setParams({ repo: id })}
      />
    )
  }

  return <RepoTasks repoId={repoId} onCreated={(taskId) => navigate(routeTo.task(taskId) + `?repo=${repoId}`)} toast={toast} repoName={repos?.find((r) => r.id === repoId)?.repo_full_name} />
}

function RepoPicker({
  loading,
  repos,
  onPick,
}: {
  loading: boolean
  repos: { id: string; repo_full_name: string }[]
  onPick: (id: string) => void
}) {
  return (
    <div>
      <PageHeader title="Tasks" description="Pick a repository to view and create engineering tasks." />
      <div className={styles.body}>
        {loading && <Skeleton height={56} />}
        {!loading && repos.length === 0 && (
          <EmptyState
            icon={<Icon name="repo" size={34} />}
            title="No repositories"
            description="Connect a repository first to create tasks."
          />
        )}
        <div className={styles.pickerGrid}>
          {repos.map((r) => (
            <Card key={r.id} interactive onClick={() => onPick(r.id)}>
              <div className={styles.pickerRow}>
                <Icon name="repo" size={18} />
                <span>{r.repo_full_name}</span>
                <Icon name="chevronRight" size={16} className={styles.pickerChevron} />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

function RepoTasks({
  repoId,
  repoName,
  onCreated,
  toast,
}: {
  repoId: string
  repoName?: string
  onCreated: (taskId: string) => void
  toast: ReturnType<typeof useToast>
}) {
  const navigate = useNavigate()
  const { data: tasks, isLoading } = useListTasksQuery(repoId)
  const [createTask, { isLoading: creating }] = useCreateTaskMutation()
  const [intent, setIntent] = useState('')

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const value = intent.trim()
    if (!value) return
    try {
      const task = await createTask({ repoId, intent: value }).unwrap()
      setIntent('')
      onCreated(task.id)
    } catch {
      toast.error('Could not create task')
    }
  }

  return (
    <div>
      <PageHeader
        title="Tasks"
        description={repoName ? `Engineering tasks for ${repoName}` : 'Engineering tasks'}
        breadcrumbs={[{ label: 'Tasks' }, ...(repoName ? [{ label: repoName }] : [])]}
      />
      <div className={styles.body}>
        <form className={styles.createBox} onSubmit={onCreate}>
          <textarea
            className={styles.intent}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Describe a task, e.g. “Add rate limiting to the login endpoint”…"
            rows={2}
          />
          <Button type="submit" variant="primary" loading={creating} disabled={!intent.trim()}>
            Create &amp; plan
          </Button>
        </form>

        {isLoading && (
          <div className={styles.list}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={64} radius={8} />
            ))}
          </div>
        )}

        {!isLoading && (tasks?.length ?? 0) === 0 && (
          <EmptyState
            compact
            icon={<Icon name="task" size={32} />}
            title="No tasks yet"
            description="Describe a change above and Forge will draft an implementation plan."
          />
        )}

        {!isLoading && tasks && tasks.length > 0 && (
          <div className={styles.list}>
            {tasks.map((task) => (
              <button
                key={task.id}
                className={styles.taskRow}
                onClick={() => navigate(routeTo.task(task.id) + `?repo=${repoId}`)}
              >
                <div className={styles.taskMain}>
                  <div className={styles.taskIntent}>{task.intent}</div>
                  <div className={styles.taskMeta}>
                    {new Date(task.created_at).toLocaleString()}
                  </div>
                </div>
                <div className={styles.taskBadges}>
                  <StatusBadge map={WORK_ITEM_STATUS} status={task.status} />
                  <StatusBadge map={APPROVAL_STATUS} status={task.approval_status} dot={false} size="sm" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Tasks
