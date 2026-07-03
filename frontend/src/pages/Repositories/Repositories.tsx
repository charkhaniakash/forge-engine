import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  EmptyState,
  Icon,
  PageHeader,
  SearchBox,
  Skeleton,
} from '@/components/common'
import { RepositoryRow } from '@/features/repositories/RepositoryRow'
import {
  useLazyGetInstallUrlQuery,
  useListReposQuery,
  useSyncReposMutation,
} from '@/services/api/repositoryApi'
import { useToast } from '@/hooks/useToast'
import { routeTo } from '@/constants/routes'
import styles from './Repositories.module.css'

export function Repositories() {
  const navigate = useNavigate()
  const toast = useToast()
  const { data: repos, isLoading } = useListReposQuery()
  const [sync, { isLoading: syncing }] = useSyncReposMutation()
  const [getInstallUrl, { isFetching: installing }] = useLazyGetInstallUrlQuery()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!repos) return []
    const q = query.trim().toLowerCase()
    return q
      ? repos.filter((r) => r.repo_full_name.toLowerCase().includes(q))
      : repos
  }, [repos, query])

  async function onSync() {
    try {
      await sync().unwrap()
      toast.success('Repositories synced')
    } catch {
      toast.error('Sync failed', { message: 'Is the GitHub App installed?' })
    }
  }

  async function onInstall() {
    try {
      const res = await getInstallUrl().unwrap()
      if (res.url) window.location.href = res.url
    } catch {
      toast.error('Could not start GitHub App install')
    }
  }

  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Connected GitHub repositories available for indexing, Q&A and tasks."
        actions={
          <>
            <Button
              variant="secondary"
              loading={syncing}
              leadingIcon={<Icon name="refresh" size={15} />}
              onClick={onSync}
            >
              Sync
            </Button>
            <Button
              variant="primary"
              loading={installing}
              leadingIcon={<Icon name="git" size={15} />}
              onClick={onInstall}
            >
              Install GitHub App
            </Button>
          </>
        }
      />

      <div className={styles.body}>
        <div className={styles.toolbar}>
          <SearchBox
            placeholder="Filter repositories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.count}>
            {repos ? `${filtered.length} of ${repos.length}` : ''}
          </span>
        </div>

        {isLoading && (
          <div className={styles.list}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={64} radius={8} />
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <EmptyState
            icon={<Icon name="repo" size={36} />}
            title={repos && repos.length > 0 ? 'No matches' : 'No repositories connected'}
            description={
              repos && repos.length > 0
                ? 'Try a different search term.'
                : 'Install the GitHub App and sync to connect your repositories.'
            }
            action={
              (!repos || repos.length === 0) && (
                <Button variant="primary" onClick={onInstall} loading={installing}>
                  Install GitHub App
                </Button>
              )
            }
          />
        )}

        {!isLoading && filtered.length > 0 && (
          <div className={styles.list}>
            {filtered.map((repo) => (
              <RepositoryRow
                key={repo.id}
                repo={repo}
                onClick={() => navigate(routeTo.repository(repo.id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Repositories
