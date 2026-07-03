import { useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  LogViewer,
  PageHeader,
  type LogLine,
} from '@/components/common'
import { WorkspaceStatusCard } from '@/features/execution/WorkspaceStatusCard'
import { useGetWorkspaceLogsQuery } from '@/services/api/workspaceApi'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './Workspace.module.css'

export function Workspace() {
  const { id: taskId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''

  const { data: logs = [] } = useGetWorkspaceLogsQuery(
    { repoId, taskId },
    { skip: !repoId || !taskId, pollingInterval: 5000 },
  )

  const logLines: LogLine[] = logs.map((l) => ({
    id: l.id,
    text:
      l.event_type === 'command'
        ? `$ ${(l.command ?? []).join(' ')}${l.exit_code != null ? `  → exit ${l.exit_code}` : ''}`
        : `[${l.lifecycle_event ?? 'lifecycle'}] ${l.message ?? ''}`,
    tone:
      l.exit_code && l.exit_code !== 0
        ? 'error'
        : l.event_type === 'command'
          ? 'info'
          : 'muted',
  }))

  const withRepo = (p: string) => `${p}?repo=${repoId}`

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Tasks', to: ROUTES.tasks },
          { label: 'Task', to: withRepo(routeTo.task(taskId)) },
          { label: 'Workspace' },
        ]}
        title={
          <span className={styles.titleRow}>
            Workspace <Badge tone="accent" size="sm">Phase 10B preview</Badge>
          </span>
        }
        description="Isolated sandbox where the agent runs. A full browser IDE arrives with Phase 10B."
      />

      <div className={styles.body}>
        <div className={styles.top}>
          <WorkspaceStatusCard repoId={repoId} taskId={taskId} />

          <Card padded={false}>
            <CardHeader title="Execution log" />
            <div className={styles.logWrap}>
              <LogViewer lines={logLines} maxHeight={280} emptyLabel="No workspace activity yet." />
            </div>
          </Card>
        </div>

        <Card>
          <div className={styles.ide}>
            <EmptyState
              icon={<Icon name="code" size={40} />}
              title="Browser IDE coming in Phase 10B"
              description="A full file tree, editor, and terminal will render here, backed by the live workspace container."
            />
          </div>
        </Card>
      </div>
    </div>
  )
}

export default Workspace
