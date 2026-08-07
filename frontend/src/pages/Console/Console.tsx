import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, ProgressBar, Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  useGetIndexStatusQuery,
  useListReposQuery,
  useLazyGetInstallUrlQuery,
  useSyncReposMutation,
  useTriggerIndexMutation,
} from '@/services/api/repositoryApi'
import { useCreateTaskMutation, useListMissionsQuery } from '@/services/api/taskApi'
import { useCreateSessionMutation } from '@/services/api/qaApi'
import { loadPlanMode, savePlanMode } from '@/features/task-workspace/planMode'
import { useToast } from '@/hooks/useToast'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { routeTo } from '@/constants/routes'
import { cn } from '@/lib/utils'

type Mode = 'agent' | 'ask'

const QUICK_STARTERS = [
  {
    title: 'Setup Stripe Webhooks',
    desc: 'Secure webhook validation with database persistence & event logging.',
    prompt: 'Build a secure Stripe webhook handler with signature validation, database event persistence, and idempotent processing.',
  },
  {
    title: 'Build Auth Router',
    desc: 'Express router with JWT, rate limiting, and password hashing.',
    prompt: 'Create an Express authentication router with JWT token management, rate limiting middleware, and bcrypt password hashing.',
  },
  {
    title: 'Configure CI/CD Pipeline',
    desc: 'GitHub Actions workflow for linting, testing, and Docker builds.',
    prompt: 'Set up a GitHub Actions CI/CD pipeline with linting, automated tests, Docker image builds, and deployment to staging.',
  },
  {
    title: 'Optimize SQL Queries',
    desc: 'Analyze slow schema relationships and add correct indexes.',
    prompt: 'Analyze the database schema for slow queries, identify missing indexes, and add query optimizations.',
  },
]

const TONE_TEXT: Record<string, string> = {
  success: 'text-success', warning: 'text-warning', danger: 'text-destructive',
  info: 'text-info', accent: 'text-primary', neutral: 'text-fg-subtle',
}

/**
 * Forge's front door — a conversational console. The user states an objective;
 * Agent mode opens an autonomous mission, Ask mode opens a grounded Q&A thread.
 */
export function Console() {
  const navigate = useNavigate()
  const toast = useToast()

  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>('agent')
  const [repoId, setRepoId] = useState(searchParams.get('repo') ?? '')
  const [prompt, setPrompt] = useState('')
  const [planMode, setPlanMode] = useState<boolean>(() => loadPlanMode())
  const togglePlanMode = () => {
    setPlanMode((prev) => {
      const next = !prev
      savePlanMode(next)
      return next
    })
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  const reposResult = useListReposQuery()
  const repos = reposResult.data ?? []
  const missionsResult = useListMissionsQuery()
  const missions = missionsResult.data ?? []

  const [createTask, { isLoading: creatingTask }] = useCreateTaskMutation()
  const [createSession, { isLoading: creatingSession }] = useCreateSessionMutation()
  const [getInstallUrl, { isLoading: installingApp }] = useLazyGetInstallUrlQuery()
  const [syncRepos, { isLoading: syncing }] = useSyncReposMutation()

  const busy = creatingTask || creatingSession
  const recent = useMemo(() => missions.slice(0, 6), [missions])

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

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const intent = prompt.trim()
    if (!intent || !repoId) {
      if (!repoId) toast.warning('Attach a repository first')
      return
    }
    if (!indexed) {
      toast.warning(indexing ? 'Repository is still indexing' : 'Index the repository first')
      return
    }
    try {
      if (mode === 'agent') {
        const task = await createTask({ repoId, intent, auto_run: !planMode }).unwrap()
        navigate(routeTo.mission(task.id) + `?repo=${repoId}`)
      } else {
        const session = await createSession(repoId).unwrap()
        navigate(routeTo.ask(session.id) + `?repo=${repoId}`, { state: { firstQuestion: intent } })
      }
    } catch {
      toast.error(mode === 'agent' ? 'Could not start mission' : 'Could not open Ask thread')
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
    <div className="flex h-full flex-col overflow-hidden bg-base">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="flex h-12 flex-shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
            Workspace / Console
          </span>
          <span className="h-4 w-px bg-line" />
          <div className="flex items-center gap-1.5 text-fg-muted">
            <Icon name="repo" size={14} className="text-fg-subtle" />
            {hasRepos ? (
              <select
                value={repoId || ''}
                onChange={(e) => setRepoId(e.target.value)}
                className="cursor-pointer rounded-md border border-border bg-base px-2 py-1 text-xs text-fg outline-none transition-colors hover:border-line-strong focus:border-primary/40"
              >
                <option value="">Select repository…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.repo_full_name}</option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-fg-subtle">No repositories connected</span>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" disabled={installingApp} onClick={handleInstall}>
            <Icon name="repo" size={14} /> Install GitHub App
          </Button>
          <Button variant="ghost" size="sm" disabled={syncing} onClick={handleSync}>
            <Icon name="refresh" size={14} /> {syncing ? 'Syncing…' : 'Sync repos'}
          </Button>
          <span className="ml-1 h-2 w-2 rounded-full bg-success shadow-[0_0_8px_var(--color-success)]" />
        </div>
      </header>

      {/* ── Scrollable content ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-12">
          {/* Brand */}
          <div className="flex flex-col items-center text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
              <Icon name="sparkles" size={28} className="text-primary" />
            </div>
            <h1 className="font-mono text-3xl font-bold tracking-[0.2em] text-fg">FORGE</h1>
            <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-fg-muted">
              Collaborate with an autonomous software engineering agent. Forge designs plans, executes
              code, runs tests, self-repairs, and publishes pull requests.
            </p>
          </div>

          <h2 className="mb-4 mt-10 text-center text-lg font-medium text-fg">
            What would you like Forge to build today?
          </h2>

          {/* Composer */}
          <form className="w-full rounded-2xl border border-border bg-card p-3 shadow-sm focus-within:border-primary/40" onSubmit={onSubmit}>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-0.5 rounded-lg border border-border bg-base p-0.5">
                {(['agent', 'ask'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                      mode === m ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg',
                    )}
                    onClick={() => setMode(m)}
                  >
                    <Icon name={m === 'agent' ? 'execution' : 'chat'} size={13} /> {m}
                  </button>
                ))}
              </div>
              <span className="text-xs text-fg-subtle">
                {mode === 'agent' ? 'Plans, executes, validates and repairs code.' : 'Answers questions about the codebase. No changes made.'}
              </span>
            </div>

            <Textarea
              className="min-h-24 resize-none border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0 dark:bg-transparent"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === 'agent'
                  ? 'e.g., Build a fast OAuth login handler using JWT tokens, write automated validation tests, and create a GitHub Actions workflow to run them...'
                  : 'e.g., How does the authentication flow work?'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(e)
              }}
            />

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {mode === 'agent' && (
                  <button
                    type="button"
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                      planMode ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border text-fg-subtle hover:text-fg',
                    )}
                    onClick={togglePlanMode}
                    aria-pressed={planMode}
                    title={planMode ? 'Plan first — review before it runs' : 'Auto-run — plan and execute'}
                  >
                    <Icon name="check" size={12} /> {planMode ? 'Plan Mode' : 'Full Autonomy'}
                  </button>
                )}
                <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-fg-subtle">
                  <Icon name="check" size={12} /> Auto-Commit
                </span>
                <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-fg-subtle">
                  <Icon name="search" size={12} /> Web Search
                </span>
              </div>

              <Button type="submit" disabled={busy || !prompt.trim() || !repoId || !indexed}>
                {busy && <Spinner size={14} />}
                {mode === 'agent' ? (planMode ? 'Start mission' : 'Run agent') : 'Ask'}
                <Icon name="chevronRight" size={14} />
              </Button>
            </div>
          </form>

          {/* Index status */}
          {repoId && (
            <div className="mt-4 w-full">
              {!indexed ? (
                indexing ? (
                  <ProgressBar
                    value={indexPct}
                    label={
                      indexJob?.total_chunks
                        ? `Indexing ${selectedRepo?.repo_full_name ?? 'repository'} · ${indexJob.progress_stage ?? 'working'} · ${indexJob.processed_chunks}/${indexJob.total_chunks}`
                        : `Indexing ${selectedRepo?.repo_full_name ?? 'repository'}…`
                    }
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
                    <Icon name="alert" size={14} />
                    <span className="text-fg-muted">
                      {indexJob?.status === 'failed'
                        ? `Indexing failed${indexJob.error ? `: ${indexJob.error}` : ''}`
                        : "This repository isn't indexed yet — Forge needs to read it first."}
                    </span>
                    <Button variant="secondary" size="sm" className="ml-auto" onClick={() => triggerIndex(repoId)} disabled={indexingTrigger}>
                      {indexingTrigger ? 'Starting…' : indexJob?.status === 'failed' ? 'Retry' : 'Index repository'}
                    </Button>
                  </div>
                )
              ) : (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[13px]">
                  <Icon name="check" size={13} className="text-success" />
                  <span className="text-fg-muted">{selectedRepo?.repo_full_name ?? 'Repository'} is indexed and ready</span>
                  {indexJob?.commit_sha && (
                    <span className="font-mono text-xs text-fg-subtle" title={indexJob.commit_sha}>@ {indexJob.commit_sha.slice(0, 7)}</span>
                  )}
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => triggerIndex(repoId)} disabled={indexingTrigger}>
                    {indexingTrigger ? 'Starting…' : 'Re-index'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* GitHub connect prompt */}
          {!repoId && !hasRepos && (
            <div className="mt-6 flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-5">
              <div className="flex items-start gap-3">
                <Icon name="repo" size={20} className="mt-0.5 flex-shrink-0 text-fg-subtle" />
                <div>
                  <strong className="text-sm font-semibold text-fg">Connect a GitHub repository</strong>
                  <p className="mt-0.5 text-[13px] text-fg-muted">Install the Forge GitHub App in your organization to get started.</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button disabled={installingApp} onClick={handleInstall}>{installingApp ? 'Loading…' : 'Install GitHub App'}</Button>
                <Button variant="outline" disabled={syncing} onClick={handleSync}>{syncing ? 'Syncing…' : 'Sync repos'}</Button>
              </div>
            </div>
          )}

          {/* Quick starters */}
          {mode === 'agent' && repoId && indexed && (
            <div className="mt-8 w-full">
              <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Quick starters</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {QUICK_STARTERS.map((qs) => (
                  <button
                    key={qs.title}
                    type="button"
                    className="group flex flex-col gap-1 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-primary/30 hover:bg-surface-2 cursor-pointer"
                    onClick={() => setPrompt(qs.prompt)}
                  >
                    <span className="text-[13px] font-medium text-fg group-hover:text-primary">{qs.title}</span>
                    <p className="text-xs leading-relaxed text-fg-subtle">{qs.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Recent missions */}
          {recent.length > 0 && (
            <div className="mt-10 w-full">
              <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Recent missions</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {recent.map((m) => {
                  const statusDef = WORK_ITEM_STATUS[m.status as keyof typeof WORK_ITEM_STATUS]
                  const statusLabel = statusDef?.label ?? m.status
                  return (
                    <button
                      key={m.id}
                      className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-line-strong hover:bg-surface-2 cursor-pointer"
                      onClick={() => navigate(routeTo.mission(m.id) + `?repo=${m.repo_id}`)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{m.intent}</span>
                        <Badge variant="outline" className={cn('flex-shrink-0 font-normal', TONE_TEXT[statusDef?.tone ?? 'neutral'])}>
                          {statusLabel}
                        </Badge>
                      </div>
                      <p className="truncate font-mono text-[11px] text-fg-subtle">
                        {repos.find((r) => r.id === m.repo_id)?.repo_full_name ?? 'repository'}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="border-t border-line-subtle px-6 py-3">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 font-mono text-[11px] text-fg-subtle">
            <span className="flex items-center gap-1.5"><Icon name="code" size={14} className="text-primary" /> Sandbox shell: bash/node v20</span>
            <span className="h-3 w-px bg-line" />
            <span className="flex items-center gap-1.5"><Icon name="tool" size={14} className="text-tertiary" /> Safety: code guardrails engaged</span>
            <span className="h-3 w-px bg-line" />
            <span className="flex items-center gap-1.5"><Icon name="file" size={14} /> API reference</span>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default Console
