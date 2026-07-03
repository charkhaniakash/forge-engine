import { Link } from 'react-router-dom'
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  PageHeader,
  Skeleton,
  StatusBadge,
} from '@/components/common'
import { useAuth } from '@/hooks/useAuth'
import { useAppSelector } from '@/app/hooks'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { ROUTES } from '@/constants/routes'
import { INDEX_JOB_STATUS } from '@/constants/status'
import styles from './Dashboard.module.css'

const MAX_REPOS_SHOWN = 4

export function Dashboard() {
  const { user } = useAuth()
  const { data: repos, isLoading: reposLoading } = useListReposQuery()
  const executions = useAppSelector((s) => s.stream.execution)

  const activeExecutions = Object.values(executions).filter(
    (bucket) => !bucket.complete,
  ).length

  const repoCount = repos?.length ?? 0
  const visibleRepos = repos?.slice(0, MAX_REPOS_SHOWN) ?? []

  const greeting = user?.name
    ? `Welcome back, ${user.name}.`
    : 'Welcome back.'

  return (
    <div>
      <PageHeader title="Dashboard" description={greeting} />

      <div className={styles.grid}>
        <Card>
          <CardHeader
            title="Repositories"
            actions={
              <Link className={styles.cardLink} to={ROUTES.repositories}>
                View all
              </Link>
            }
          />
          {reposLoading ? (
            <div className={styles.skeletonStack}>
              <Skeleton height={32} width={80} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          ) : repoCount === 0 ? (
            <EmptyState
              compact
              title="No repositories yet"
              description="Connect a GitHub repository to get started."
            />
          ) : (
            <>
              <div className={styles.metric}>
                <span className={styles.metricValue}>{repoCount}</span>
                <span className={styles.metricLabel}>
                  {repoCount === 1 ? 'repository' : 'repositories'} connected
                </span>
              </div>
              <div className={styles.repoList}>
                {visibleRepos.map((repo) => (
                  <Link
                    key={repo.id}
                    className={styles.repoRow}
                    to={ROUTES.repositories}
                  >
                    <span className={styles.repoName}>
                      <Icon className={styles.repoIcon} name="repo" size={14} />
                      <span>{repo.repo_full_name}</span>
                    </span>
                    <StatusBadge
                      map={INDEX_JOB_STATUS}
                      status={repo.last_synced_at ? 'done' : 'queued'}
                      size="sm"
                    />
                  </Link>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent tasks" />
          <EmptyState
            compact
            title="No recent tasks"
            description="Tasks you create across repositories will surface here."
          />
        </Card>

        <Card>
          <CardHeader title="Active executions" />
          {activeExecutions > 0 ? (
            <div className={styles.metric}>
              <span className={styles.metricValue}>{activeExecutions}</span>
              <span className={styles.metricLabel}>
                {activeExecutions === 1 ? 'execution' : 'executions'} in progress
              </span>
            </div>
          ) : (
            <EmptyState
              compact
              title="Nothing running"
              description="Live executions appear here while they run."
            />
          )}
        </Card>

        <Card>
          <CardHeader title="Recent Q&A sessions" />
          <EmptyState
            compact
            title="No Q&A sessions yet"
            description="Ask questions about your indexed repositories to see them here."
          />
        </Card>

        <Card>
          <CardHeader title="Workspace health" />
          <div className={styles.health}>
            <Badge tone="success" dot>
              Operational
            </Badge>
            <p className={styles.note}>All execution workspaces are healthy.</p>
          </div>
        </Card>

        <Card>
          <CardHeader title="Usage summary" />
          <EmptyState
            compact
            title="No usage data"
            description="Usage tracking arrives in Phase 13."
          />
        </Card>
      </div>
    </div>
  )
}

export default Dashboard
