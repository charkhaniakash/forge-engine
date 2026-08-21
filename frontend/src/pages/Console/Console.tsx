import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, ProgressBar, Spinner } from '@/components/common'
import { ForgeMark } from '@/components/common/ForgeMark/ForgeMark'
import { Button } from '@/components/ui/button'
import { RepositorySelectDialog } from '@/features/repositories/RepositorySelectDialog'
import {
  useGetIndexStatusQuery,
  useListReposQuery,
  useLazyGetInstallUrlQuery,
  useSyncReposMutation,
  useTriggerIndexMutation,
} from '@/services/api/repositoryApi'
import { useCreateTaskMutation } from '@/services/api/taskApi'
import { useCreateSessionMutation } from '@/services/api/qaApi'
import { loadPlanMode, savePlanMode } from '@/features/task-workspace/planMode'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

type Mode = 'mission' | 'ask'

const SUGGESTIONS = [
  'Add rate limiting to the auth middleware',
  'Write tests for the payment webhook handler',
  'Refactor the user service into smaller modules',
]

export function Console() {
  const navigate = useNavigate()
  const toast = useToast()

  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>('mission')
  const [repoId, setRepoId] = useState(searchParams.get('repo') ?? '')
  const [prompt, setPrompt] = useState('')
  const [planMode, setPlanMode] = useState(() => loadPlanMode())
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)

  const reposResult = useListReposQuery()
  const repos = reposResult.data ?? []
  const reposLoading = reposResult.isLoading

  useEffect(() => {
    if (!reposLoading && repos.length > 0 && !repoId) {
      setRepoPickerOpen(true)
    }
  }, [reposLoading, repos.length, repoId])

  const [createTask, { isLoading: creatingTask }] = useCreateTaskMutation()
  const [createSession, { isLoading: creatingSession }] = useCreateSessionMutation()
  const [getInstallUrl, { isLoading: installingApp }] = useLazyGetInstallUrlQuery()
  const [syncRepos, { isLoading: syncing }] = useSyncReposMutation()

  const busy = creatingTask || creatingSession

  const { data: index } = useGetIndexStatusQuery(repoId, { skip: !repoId, pollingInterval: 2000 })
  const [triggerIndex, { isLoading: indexingTrigger }] = useTriggerIndexMutation()
  const indexJob = index?.job
  const indexed = index?.status === 'done'
  const indexing =
    index?.status === 'indexing' || indexJob?.status === 'running' || indexJob?.status === 'queued'
  const indexPct =
    indexJob && indexJob.total_chunks ? indexJob.processed_chunks / indexJob.total_chunks : undefined

  const selectedRepo = repos.find((r) => r.id === repoId)
  const hasRepos = repos.length > 0
  const canSubmit = Boolean(prompt.trim() && repoId && indexed && !busy)

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault()
    const intent = prompt.trim()
    if (!intent || !repoId) {
      if (!repoId) {
        toast.warning('Pick a repository first')
        setRepoPickerOpen(true)
      }
      return
    }
    if (!indexed) {
      toast.warning(indexing ? 'Still indexing…' : 'Index the repo first')
      return
    }
    try {
      if (mode === 'mission') {
        const task = await createTask({ repoId, intent, auto_run: !planMode }).unwrap()
        navigate(`/mission/${task.id}?repo=${repoId}`)
      } else {
        const session = await createSession(repoId).unwrap()
        navigate(`/ask/${session.id}?repo=${repoId}`, { state: { firstQuestion: intent } })
      }
    } catch {
      toast.error(mode === 'mission' ? 'Could not start mission' : 'Could not open thread')
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void onSubmit()
    }
  }

  async function handleInstall() {
    try {
      const result = await getInstallUrl().unwrap()
      window.location.href = result.install_url
    } catch {
      toast.error('Failed to get install URL')
    }
  }

  async function handleSync() {
    try {
      await syncRepos().unwrap()
      toast.success('Repos synced')
    } catch {
      toast.error('Sync failed')
    }
  }

  return (
    <div className="console-page flex h-full flex-col bg-base">
      <RepositorySelectDialog
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        repos={repos}
        selectedId={repoId}
        loading={reposLoading}
        onConfirm={setRepoId}
      />

      {/* Minimal top strip — no heavy chrome */}
      <div className="flex h-12 shrink-0 items-center justify-end gap-1 px-4">
        {!hasRepos && (
          <Button variant="ghost" size="sm" className="h-8 text-fg-muted" disabled={installingApp} onClick={handleInstall}>
            Connect GitHub
          </Button>
        )}
        {hasRepos && (
          <Button variant="ghost" size="sm" className="h-8 text-fg-subtle" disabled={syncing} onClick={handleSync}>
            <Icon name="refresh" size={14} className={syncing ? 'animate-spin' : ''} />
          </Button>
        )}
      </div>

      {/* Centered stage */}
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-16 pt-4">
        <div className="w-full max-w-[640px]">
          {/* Brand */}
          <div className="mb-10 flex flex-col items-center text-center">
            <ForgeMark size="lg" className="mb-5" />
            <h1 className="text-[26px] font-semibold tracking-tight text-fg">
              Forge{' '}
              <span className="bg-gradient-to-r from-primary to-tertiary bg-clip-text font-semibold text-transparent">
                {mode === 'mission' ? 'Mission' : 'Ask'}
              </span>
            </h1>
          </div>

          {/* Composer shell */}
          <div className="relative">
            {/* Mode pill — floats top-right like reference but different labels */}
            <div className="absolute -top-3 right-3 z-10 flex items-center rounded-full border border-line bg-surface-2 p-0.5 shadow-sm">
              {(['mission', 'ask'] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    'cursor-pointer rounded-full px-3.5 py-1 text-[12px] font-medium capitalize transition-all',
                    mode === m ? 'bg-surface-3 text-fg' : 'text-fg-subtle hover:text-fg-muted',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>

            <form
              onSubmit={onSubmit}
              className={cn(
                'console-composer overflow-hidden rounded-2xl border border-line bg-surface-2',
                'shadow-[0_16px_48px_-24px_rgba(0,0,0,0.8)]',
                'transition-colors focus-within:border-line-strong',
              )}
            >
              {/* Repo chip row */}
              <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => (hasRepos ? setRepoPickerOpen(true) : handleInstall())}
                  className={cn(
                    'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1',
                    'font-mono text-[12px] text-primary transition-colors hover:bg-surface-3',
                  )}
                >
                  <span className="text-fg-subtle">@</span>
                  <span className="truncate">
                    {selectedRepo?.repo_full_name ?? (hasRepos ? 'select-repo' : 'connect-github')}
                  </span>
                </button>
                {indexing && (
                  <span className="ml-auto text-[11px] text-fg-subtle">Indexing…</span>
                )}
                {indexed && !indexing && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg-subtle">
                    <Icon name="check" size={11} className="text-primary" />
                    Ready
                  </span>
                )}
              </div>

              {/* Input */}
              <div className="px-4 py-3">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={3}
                  placeholder={
                    mode === 'mission'
                      ? 'What should Forge build or fix in this repo?'
                      : 'Ask anything about this codebase…'
                  }
                  className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle/50"
                />
              </div>

              {/* Action bar */}
              <div className="flex items-center justify-between px-3 pb-3 pt-0">
                <div className="flex items-center gap-1">
                  {mode === 'mission' && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = !planMode
                        setPlanMode(next)
                        savePlanMode(next)
                      }}
                      className={cn(
                        'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors',
                        planMode
                          ? 'bg-surface-3 text-fg'
                          : 'text-fg-subtle hover:bg-surface-3 hover:text-fg-muted',
                      )}
                    >
                      <Icon name="plus" size={14} />
                      {planMode ? 'Plan first' : 'Auto-run'}
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={!canSubmit}
                  aria-label="Send"
                  className={cn(
                    'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full transition-all',
                    canSubmit
                      ? 'bg-fg text-base hover:brightness-90 active:scale-95'
                      : 'bg-surface-3 text-fg-subtle cursor-not-allowed',
                  )}
                >
                  {busy ? (
                    <Spinner size={16} />
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M12 19V5M12 5l-5 5M12 5l5 5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Context footer — repo + branch + index status */}
          {selectedRepo && (
            <div className="mt-3 flex flex-col items-center gap-2">
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12px] text-fg-subtle">
                <button
                  type="button"
                  onClick={() => setRepoPickerOpen(true)}
                  className="inline-flex cursor-pointer items-center gap-1.5 transition-colors hover:text-fg-muted"
                >
                  <Icon name="folder" size={13} />
                  {selectedRepo.repo_full_name}
                </button>
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="branch" size={13} />
                  {selectedRepo.default_branch}
                  <span className="text-fg-subtle/60">(default)</span>
                </span>
              </div>

              {indexed ? (
                <div className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-fg-subtle">
                  <span className="inline-flex items-center gap-1.5 text-fg-muted">
                    <Icon name="check" size={12} className="text-primary" />
                    Indexed
                    {indexJob?.commit_sha && (
                      <span className="font-mono text-[11px]" title={indexJob.commit_sha}>
                        @ {indexJob.commit_sha.slice(0, 7)}
                      </span>
                    )}
                  </span>
                  <span className="text-fg-subtle/40">·</span>
                  <button
                    type="button"
                    onClick={() => triggerIndex(repoId)}
                    disabled={indexingTrigger || indexing}
                    className="inline-flex cursor-pointer items-center gap-1 text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Icon name="refresh" size={12} className={indexingTrigger ? 'animate-spin' : ''} />
                    {indexingTrigger ? 'Starting…' : indexing ? 'Indexing…' : 'Re-index'}
                  </button>
                </div>
              ) : indexing ? (
                <div className="w-full max-w-md pt-1">
                  <ProgressBar
                    value={indexPct}
                    label={
                      indexJob?.total_chunks
                        ? `Reading repo · ${indexJob.processed_chunks}/${indexJob.total_chunks}`
                        : 'Reading repository…'
                    }
                  />
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-center gap-2 text-[12px]">
                  <span className="inline-flex items-center gap-1.5 text-fg-muted">
                    <Icon name="alert" size={12} className="text-warning" />
                    {indexJob?.status === 'failed' ? 'Indexing failed' : 'Not indexed yet'}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-3 text-[12px]"
                    onClick={() => triggerIndex(repoId)}
                    disabled={indexingTrigger}
                  >
                    {indexingTrigger ? 'Starting…' : indexJob?.status === 'failed' ? 'Retry index' : 'Index now'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Suggestion chips — subtle, not a grid of cards */}
          {mode === 'mission' && repoId && indexed && !prompt && (
            <div className="mt-8 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPrompt(s)}
                  className="cursor-pointer rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Empty state — no repos */}
          {!hasRepos && !reposLoading && (
            <div className="mt-10 text-center">
              <p className="text-[13px] text-fg-muted">Connect GitHub to start your first session.</p>
              <Button className="mt-4" disabled={installingApp} onClick={handleInstall}>
                {installingApp ? 'Loading…' : 'Install GitHub App'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Console
