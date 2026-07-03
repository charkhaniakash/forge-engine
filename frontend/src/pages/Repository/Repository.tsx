import { useNavigate, useParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  PageHeader,
  ProgressBar,
  Skeleton,
  StatusBadge,
} from '@/components/common'
import {
  useGetIndexStatusQuery,
  useListReposQuery,
  useTriggerIndexMutation,
} from '@/services/api/repositoryApi'
import { useToast } from '@/hooks/useToast'
import { INDEX_JOB_STATUS } from '@/constants/status'
import { ROUTES, routeTo } from '@/constants/routes'
import styles from './Repository.module.css'

export function Repository() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: repos, isLoading } = useListReposQuery()
  const repo = repos?.find((r) => r.id === id)

  const { data: index } = useGetIndexStatusQuery(id, {
    skip: !id,
    pollingInterval: 3000,
  })
  const [triggerIndex, { isLoading: triggering }] = useTriggerIndexMutation()

  const job = index?.job
  const indexed = index?.status === 'done'

  async function onIndex() {
    try {
      await triggerIndex(id).unwrap()
      toast.info('Indexing started')
    } catch {
      toast.error('Failed to trigger indexing')
    }
  }

  if (isLoading) {
    return (
      <div className={styles.body}>
        <Skeleton height={40} width={320} />
        <div style={{ height: 24 }} />
        <Skeleton height={160} radius={8} />
      </div>
    )
  }

  if (!repo) {
    return (
      <EmptyState
        icon={<Icon name="repo" size={36} />}
        title="Repository not found"
        description="It may not be connected to this organization."
        action={
          <Button variant="secondary" onClick={() => navigate(ROUTES.repositories)}>
            Back to repositories
          </Button>
        }
      />
    )
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: 'Repositories', to: ROUTES.repositories },
          { label: repo.repo_full_name },
        ]}
        title={repo.repo_full_name}
        actions={
          <>
            <Button
              variant="secondary"
              leadingIcon={<Icon name="chat" size={15} />}
              onClick={() => navigate(routeTo.repositoryQA(repo.id))}
              disabled={!indexed}
            >
              Ask Q&A
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<Icon name="task" size={15} />}
              onClick={() => navigate(ROUTES.tasks + `?repo=${repo.id}`)}
              disabled={!indexed}
            >
              Tasks
            </Button>
            <Button
              variant="primary"
              leadingIcon={<Icon name="refresh" size={15} />}
              loading={triggering}
              onClick={onIndex}
            >
              {indexed ? 'Re-index' : 'Index'}
            </Button>
          </>
        }
      />

      <div className={styles.body}>
        <div className={styles.grid}>
          <Card padded={false}>
            <CardHeader title="Repository details" />
            <div className={styles.rows}>
              <Row label="Owner" value={repo.repo_owner} />
              <Row
                label="Default branch"
                value={
                  <span className={styles.mono}>
                    <Icon name="branch" size={12} /> {repo.default_branch}
                  </span>
                }
              />
              <Row
                label="Visibility"
                value={<Badge tone="neutral" size="sm">{repo.private ? 'Private' : 'Public'}</Badge>}
              />
              <Row
                label="Last synced"
                value={
                  repo.last_synced_at
                    ? new Date(repo.last_synced_at).toLocaleString()
                    : 'Never'
                }
              />
            </div>
          </Card>

          <Card padded={false}>
            <CardHeader
              title="Index status"
              actions={<StatusBadge map={INDEX_JOB_STATUS} status={job?.status} />}
            />
            <div className={styles.rows}>
              {!job && (
                <div className={styles.empty}>
                  Not indexed yet. Trigger indexing to enable Q&A and tasks.
                </div>
              )}
              {job && (
                <>
                  {job.status === 'running' && job.total_chunks != null && (
                    <div className={styles.progress}>
                      <ProgressBar
                        value={job.total_chunks ? job.processed_chunks / job.total_chunks : undefined}
                        label={`${job.progress_stage ?? 'working'} · ${job.processed_chunks}/${job.total_chunks} chunks`}
                      />
                    </div>
                  )}
                  <Row label="Commit" value={<span className={styles.mono}>{job.commit_sha.slice(0, 7)}</span>} />
                  <Row label="Chunks processed" value={String(job.processed_chunks)} />
                  {job.status === 'failed' && job.error && (
                    <div className={styles.error}>{job.error}</div>
                  )}
                </>
              )}
            </div>
          </Card>
        </div>

        <Card padded={false} className={styles.metaCard}>
          <CardHeader title="Metadata" />
          <div className={styles.rows}>
            <Row label="Repository ID" value={<span className={styles.mono}>{repo.id}</span>} />
            <Row label="Indexed commit" value={<span className={styles.mono}>{job?.commit_sha.slice(0, 12) ?? '—'}</span>} />
          </div>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}

export default Repository
