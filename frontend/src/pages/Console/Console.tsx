import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, ProgressBar, Spinner } from '@/components/common'
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
import styles from './Console.module.css'

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

/**
 * Forge's front door — a conversational console matching the Welcome State design.
 * The user states an objective; Agent mode opens an autonomous mission, Ask mode opens
 * a grounded Q&A thread. All real functionality is preserved.
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
  // RTK Query can return `data: null` before the first successful response.
  // Destructuring with `= []` only guards against `undefined`, not `null`.
  // Using `?? []` handles both cases safely.
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
    indexJob && indexJob.total_chunks
      ? indexJob.processed_chunks / indexJob.total_chunks
      : undefined

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
        navigate(routeTo.ask(session.id) + `?repo=${repoId}`, {
          state: { firstQuestion: intent },
        })
      }
    } catch {
      toast.error(mode === 'agent' ? 'Could not start mission' : 'Could not open Ask thread')
    }
  }

  function handleQuickStart(p: string) {
    setPrompt(p)
  }

  function renderRepoSelect() {
    return (
      <select
        value={repoId || ''}
        onChange={(e) => setRepoId(e.target.value)}
        className={styles.repoSelect}
      >
        <option value="">Select repository…</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.repo_full_name}
          </option>
        ))}
      </select>
    )
  }

  return (
    <div className={styles.page}>
      {/* ── Top Navigation Header ─────────────────────────────────────────── */}
      <header className={styles.topNav}>
        <div className={styles.topNavLeft}>
          <span className={styles.topNavLabel}>WORKSPACE / CONSOLE</span>
          <span className={styles.topNavDivider} />
          <div className={styles.topNavRepo}>
            <Icon name="repo" size={14} />
            {hasRepos ? renderRepoSelect() : (
              <span className={styles.noRepo}>No repositories connected</span>
            )}
          </div>
        </div>
        <div className={styles.topNavRight}>
          <div className={styles.topNavActions}>
            <button
              className={styles.installBtn}
              disabled={installingApp}
              onClick={async () => {
                try {
                  const result = await getInstallUrl().unwrap()
                  window.location.href = result.install_url
                } catch {
                  toast.error('Failed to get install URL')
                }
              }}
            >
              <Icon name="repo" size={14} />
              Install GitHub App
            </button>
            <button
              className={styles.syncBtn}
              disabled={syncing}
              onClick={async () => {
                try {
                  await syncRepos().unwrap()
                  toast.success('Repos synced')
                } catch {
                  toast.error('Sync failed')
                }
              }}
            >
              <Icon name="refresh" size={14} />
              {syncing ? 'Syncing…' : 'Sync repos'}
            </button>
          </div>
          {selectedRepo && (
            <span className={styles.gpuLabel}>GPU: H100 Node 4</span>
          )}
          <span className={styles.statusDotLive} />
        </div>
      </header>

      {/* ── Central Content ───────────────────────────────────────────────── */}
      <div className={styles.content}>
        <div className={styles.hero}>
          {/* Brand */}
          <div className={styles.brand}>
            <div className={styles.brandOuter}>
              <div className={styles.brandInner}>
                <Icon name="sparkles" size={28} className={styles.brandIcon} />
              </div>
            </div>
            <h1 className={styles.title}>FORGE</h1>
            <p className={styles.subtitle}>
              Collaborate with an autonomous software engineering agent.
              Forge designs plans, executes code, runs tests, self-repairs, and publishes pull requests.
            </p>
          </div>

          {/* Prompt */}
          <h2 className={styles.promptHeading}>
            What would you like Forge to build today?
          </h2>

          <form className={styles.composer} onSubmit={onSubmit}>
            <div className={styles.modeRow}>
              <div className={styles.modes}>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${mode === 'agent' ? styles.modeActive : ''}`}
                  onClick={() => setMode('agent')}
                >
                  <Icon name="execution" size={13} />
                  Agent
                </button>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${mode === 'ask' ? styles.modeActive : ''}`}
                  onClick={() => setMode('ask')}
                >
                  <Icon name="chat" size={13} />
                  Ask
                </button>
              </div>
              <span className={styles.modeHint}>
                {mode === 'agent'
                  ? 'Plans, executes, validates and repairs code.'
                  : 'Answers questions about the codebase. No changes made.'}
              </span>
            </div>

            <textarea
              className={styles.textarea}
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

            <div className={styles.composerActions}>
              <div className={styles.capabilities}>
                {mode === 'agent' && (
                  <button
                    type="button"
                    className={`${styles.capBtn} ${planMode ? styles.capBtnActive : ''}`}
                    onClick={togglePlanMode}
                    title={
                      planMode
                        ? 'Plan first — review the plan before it runs'
                        : 'Auto-run — plan and execute without a review step'
                    }
                    aria-pressed={planMode}
                  >
                    <Icon name="check" size={12} />
                    {planMode ? 'Plan Mode' : 'Full Autonomy'}
                  </button>
                )}
                <button type="button" className={styles.capBtn}>
                  <Icon name="check" size={12} />
                  Auto-Commit
                </button>
                <button type="button" className={styles.capBtn}>
                  <Icon name="search" size={12} />
                  Web Search
                </button>
              </div>

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={busy || !prompt.trim() || !repoId || !indexed}
              >
                {busy ? <Spinner size={14} color="#050507" /> : null}
                <span>{mode === 'agent' ? (planMode ? 'START MISSION' : 'RUN AGENT') : 'ASK'}</span>
                <Icon name="chevronRight" size={14} />
              </button>
            </div>
          </form>

          {/* ── Index status ────────────────────────────────────────────────── */}
          {repoId && (
            <div className={styles.indexArea}>
              {!indexed && (
                <div className={styles.indexGate}>
                  {indexing ? (
                    <div className={styles.indexing}>
                      <ProgressBar
                        value={indexPct}
                        label={
                          indexJob?.total_chunks
                            ? `Indexing ${selectedRepo?.repo_full_name ?? 'repository'} · ${indexJob.progress_stage ?? 'working'} · ${indexJob.processed_chunks}/${indexJob.total_chunks}`
                            : `Indexing ${selectedRepo?.repo_full_name ?? 'repository'}…`
                        }
                      />
                    </div>
                  ) : indexJob?.status === 'failed' ? (
                    <div className={styles.indexFailed}>
                      <Icon name="alert" size={14} />
                      <span>Indexing failed{indexJob.error ? `: ${indexJob.error}` : ''}</span>
                      <button
                        type="button"
                        className={styles.indexActionBtn}
                        onClick={() => triggerIndex(repoId)}
                        disabled={indexingTrigger}
                      >
                        {indexingTrigger ? 'Starting…' : 'Retry'}
                      </button>
                    </div>
                  ) : (
                    <div className={styles.notIndexed}>
                      <Icon name="alert" size={14} />
                      <span>This repository isn't indexed yet — Forge needs to read it first.</span>
                      <button
                        type="button"
                        className={styles.indexActionBtn}
                        onClick={() => triggerIndex(repoId)}
                        disabled={indexingTrigger}
                      >
                        {indexingTrigger ? 'Starting…' : 'Index repository'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {indexed && (
                <div className={styles.indexed}>
                  <Icon name="check" size={13} />
                  <span>{selectedRepo?.repo_full_name ?? 'Repository'} is indexed and ready</span>
                  {indexJob?.commit_sha && (
                    <span className={styles.commitSha} title={indexJob.commit_sha}>
                      @ {indexJob.commit_sha.slice(0, 7)}
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.indexActionBtn}
                    onClick={() => triggerIndex(repoId)}
                    disabled={indexingTrigger}
                  >
                    {indexingTrigger ? 'Starting…' : 'Re-index'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── GitHub Connect Prompt (when no repo selected) ────────────────── */}
          {!repoId && !hasRepos && (
            <div className={styles.connectPrompt}>
              <div className={styles.connectPromptContent}>
                <Icon name="repo" size={20} />
                <div>
                  <strong>Connect a GitHub repository</strong>
                  <p>Install the Forge GitHub App in your organization to get started.</p>
                </div>
              </div>
              <div className={styles.connectActions}>
                <button
                  className={styles.connectPrimaryBtn}
                  disabled={installingApp}
                  onClick={async () => {
                    try {
                      const result = await getInstallUrl().unwrap()
                      window.location.href = result.install_url
                    } catch {
                      toast.error('Failed to get install URL')
                    }
                  }}
                >
                  {installingApp ? 'Loading…' : 'Install GitHub App'}
                </button>
                <button
                  className={styles.connectSecondaryBtn}
                  disabled={syncing}
                  onClick={async () => {
                    try {
                      await syncRepos().unwrap()
                      toast.success('Repos synced')
                    } catch {
                      toast.error('Sync failed')
                    }
                  }}
                >
                  {syncing ? 'Syncing…' : 'Sync repos'}
                </button>
              </div>
            </div>
          )}

          {/* ── Quick Starters ──────────────────────────────────────────────── */}
          {mode === 'agent' && repoId && indexed && (
            <div className={styles.quickStarters}>
              <div className={styles.quickStartersHead}>Quick Starters</div>
              <div className={styles.quickStartersGrid}>
                {QUICK_STARTERS.map((qs) => (
                  <button
                    key={qs.title}
                    type="button"
                    className={styles.quickStarterCard}
                    onClick={() => handleQuickStart(qs.prompt)}
                  >
                    <span className={styles.quickStarterTitle}>{qs.title}</span>
                    <p className={styles.quickStarterDesc}>{qs.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Recent Missions ────────────────────────────────────────────────── */}
        {recent.length > 0 && (
          <div className={styles.recentSection}>
            <div className={styles.recentHead}>Recent Missions</div>
            <div className={styles.recentGrid}>
              {recent.map((m) => {
                const statusDef = WORK_ITEM_STATUS[m.status as keyof typeof WORK_ITEM_STATUS]
                const statusLabel = statusDef?.label ?? m.status
                const statusColor = statusDef?.tone ? `var(--${statusDef.tone})` : 'var(--neutral)'
                return (
                  <button
                    key={m.id}
                    className={styles.recentCard}
                    onClick={() => navigate(routeTo.mission(m.id) + `?repo=${m.repo_id}`)}
                  >
                    <div className={styles.recentCardTop}>
                      <span className={styles.recentCardIntent}>{m.intent}</span>
                      <span
                        className={styles.recentCardBadge}
                        style={{ color: statusColor, background: statusColor.startsWith('#') ? `${statusColor}30` : 'var(--neutral-subtle)' }}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <p className={styles.recentCardRepo}>
                      {repos.find((r) => r.id === m.repo_id)?.repo_full_name ?? 'repository'}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Bottom Footer ────────────────────────────────────────────────── */}
        <footer className={styles.bottomFooter}>
          <div className={styles.footerItems}>
            <span className={styles.footerItem}>
              <Icon name="code" size={14} className={styles.footerIcon} />
              Sandbox Shell: bash/node v20
            </span>
            <span className={styles.footerDivider} />
            <span className={styles.footerItem}>
              <Icon name="tool" size={14} className={styles.footerIconSecondary} />
              Safety: Code Guardrails Engaged
            </span>
            <span className={styles.footerDivider} />
            <span className={styles.footerItem}>
              <Icon name="file" size={14} />
              API Reference
            </span>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default Console
