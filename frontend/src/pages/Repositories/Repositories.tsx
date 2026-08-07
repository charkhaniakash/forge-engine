import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { RepositoryRow } from '@/features/repositories/RepositoryRow'
import {
  useLazyGetInstallUrlQuery,
  useListReposQuery,
  useSyncReposMutation,
} from '@/services/api/repositoryApi'
import { useToast } from '@/hooks/useToast'

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
    return q ? repos.filter((r) => r.repo_full_name.toLowerCase().includes(q)) : repos
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
      if (res.install_url) window.location.href = res.install_url
    } catch {
      toast.error('Could not start GitHub App install')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-base">
      {/* Page header */}
      <header className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-line px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-fg">Repositories</h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            Connected GitHub repositories available for indexing, Q&amp;A and tasks.
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button variant="outline" disabled={syncing} onClick={onSync}>
            <Icon name="refresh" size={15} /> {syncing ? 'Syncing…' : 'Sync'}
          </Button>
          <Button disabled={installing} onClick={onInstall}>
            <Icon name="git" size={15} /> Install GitHub App
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-5">
          {/* Toolbar */}
          <div className="mb-4 flex items-center gap-3">
            <div className="relative flex-1">
              <Icon name="search" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <Input
                className="pl-9"
                placeholder="Filter repositories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span className="flex-shrink-0 font-mono text-xs text-fg-subtle">
              {repos ? `${filtered.length} of ${repos.length}` : ''}
            </span>
          </div>

          {isLoading && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          )}

          {!isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle">
                <Icon name="repo" size={28} />
              </div>
              <div>
                <p className="text-sm font-semibold text-fg">
                  {repos && repos.length > 0 ? 'No matches' : 'No repositories connected'}
                </p>
                <p className="mt-1 max-w-xs text-[13px] text-fg-subtle">
                  {repos && repos.length > 0
                    ? 'Try a different search term.'
                    : 'Install the GitHub App and sync to connect your repositories.'}
                </p>
              </div>
              {(!repos || repos.length === 0) && (
                <Button className="mt-1" onClick={onInstall} disabled={installing}>Install GitHub App</Button>
              )}
            </div>
          )}

          {!isLoading && filtered.length > 0 && (
            <div className="flex flex-col gap-2">
              {filtered.map((repo) => (
                <RepositoryRow key={repo.id} repo={repo} onClick={() => navigate(`/?repo=${repo.id}`)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Repositories
