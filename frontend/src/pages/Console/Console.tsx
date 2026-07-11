import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Icon, ProgressBar, Spinner, StatusBadge } from '@/components/common'
import {
  useGetIndexStatusQuery,
  useListReposQuery,
  useLazyGetInstallUrlQuery,
  useSyncReposMutation,
  useTriggerIndexMutation,
} from '@/services/api/repositoryApi'
import { useCreateTaskMutation, useListMissionsQuery } from '@/services/api/taskApi'
import { useCreateSessionMutation } from '@/services/api/qaApi'
import { useToast } from '@/hooks/useToast'
import { useAuth } from '@/hooks/useAuth'
import { WORK_ITEM_STATUS } from '@/constants/status'
import { routeTo } from '@/constants/routes'
import styles from './Console.module.css'

type Mode = 'agent' | 'ask'

/**
 * Forge's front door — a conversational console, not a dashboard. The user
 * states an objective; Agent mode opens an autonomous mission, Ask mode opens
 * a grounded Q&A thread. Recent missions are the real task list for the chosen
 * repository (no invented data).
 */
export function Console() {
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()

  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>('agent')
  const [repoId, setRepoId] = useState(searchParams.get('repo') ?? '')
  const [prompt, setPrompt] = useState('')

  const { data: repos = [] } = useListReposQuery()
  const { data: missions = [] } = useListMissionsQuery()
  const [createTask, { isLoading: creatingTask }] = useCreateTaskMutation()
  const [createSession, { isLoading: creatingSession }] = useCreateSessionMutation()
  const [getInstallUrl, { isLoading: installingApp }] = useLazyGetInstallUrlQuery()
  const [syncRepos, { isLoading: syncing }] = useSyncReposMutation()

  const busy = creatingTask || creatingSession
  const recent = useMemo(() => missions.slice(0, 6), [missions])
  const repoName = (id: string) => repos.find((r) => r.id === id)?.repo_full_name ?? ''

  // A repository must be indexed before it can be used for Agent or Ask. Gate
  // the whole flow on real index status (polled only while indexing).
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
        const task = await createTask({ repoId, intent }).unwrap()
        navigate(routeTo.mission(task.id) + `?repo=${repoId}`)
      } else {
        const session = await createSession(repoId).unwrap()
        // Continuous chat: hand the first question to the thread via state so it
        // streams immediately — no intermediate screen.
        navigate(routeTo.ask(session.id) + `?repo=${repoId}`, {
          state: { firstQuestion: intent },
        })
      }
    } catch {
      toast.error(mode === 'agent' ? 'Could not start mission' : 'Could not open Ask thread')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span> Forge
        </div>
        <h1 className={styles.headline}>Autonomous Software Engineer</h1>
        <p className={styles.sub}>
          {user?.name ? `${user.name}, what` : 'What'} would you like me to build or fix?
        </p>

        <form className={styles.composer} onSubmit={onSubmit}>
          <div className={styles.modeRow}>
            <div className={styles.modes}>
              <button
                type="button"
                className={`${styles.mode} ${mode === 'agent' ? styles.modeActive : ''}`}
                onClick={() => setMode('agent')}
              >
                <Icon name="execution" size={14} /> Agent
              </button>
              <button
                type="button"
                className={`${styles.mode} ${mode === 'ask' ? styles.modeActive : ''}`}
                onClick={() => setMode('ask')}
              >
                <Icon name="chat" size={14} /> Ask
              </button>
            </div>
            <span className={styles.modeHint}>
              {mode === 'agent'
                ? 'Plans, executes, validates and repairs code.'
                : 'Answers questions about the codebase. No changes made.'}
            </span>
          </div>

          <textarea
            className={styles.input}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === 'agent'
                ? 'e.g. Fix the regression in the Add Song workflow and make validation pass'
                : 'e.g. How does the authentication flow work?'
            }
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(e)
            }}
          />

          <div className={styles.actions}>
            <label className={styles.attach}>
              <Icon name="repo" size={15} />
              <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={styles.repoSelect}>
                <option value="">Attach repository…</option>
                {repos?.map((r) => (
                  <option key={r.id} value={r.id}>{r.repo_full_name}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className={styles.submit}
              disabled={busy || !prompt.trim() || !repoId || !indexed}
            >
              {busy ? <Spinner size={15} color="#fff" /> : <Icon name="chevronRight" size={16} />}
              {mode === 'agent' ? 'Start mission' : 'Ask'}
            </button>
          </div>

          {repoId && !indexed && (
            <div className={styles.indexGate}>
              {indexing ? (
                <div className={styles.indexing}>
                  <ProgressBar
                    value={indexPct}
                    label={
                      indexJob?.total_chunks
                        ? `Indexing ${repoName(repoId)} · ${indexJob.progress_stage ?? 'working'} · ${indexJob.processed_chunks}/${indexJob.total_chunks}`
                        : `Indexing ${repoName(repoId)}…`
                    }
                  />
                </div>
              ) : indexJob?.status === 'failed' ? (
                <div className={styles.indexFailed}>
                  <Icon name="alert" size={14} /> Indexing failed{indexJob.error ? `: ${indexJob.error}` : ''}
                  <button
                    type="button"
                    className={styles.indexBtn}
                    onClick={() => triggerIndex(repoId)}
                    disabled={indexingTrigger}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <div className={styles.notIndexed}>
                  <Icon name="alert" size={14} />
                  <span>This repository isn't indexed yet — Forge needs to read it first.</span>
                  <button
                    type="button"
                    className={styles.indexBtn}
                    onClick={() => triggerIndex(repoId)}
                    disabled={indexingTrigger}
                  >
                    {indexingTrigger ? 'Starting…' : 'Index repository'}
                  </button>
                </div>
              )}
            </div>
          )}
          {repoId && indexed && (
            <div className={styles.indexed}>
              <Icon name="check" size={13} /> {repoName(repoId)} is indexed and ready
              {indexJob?.commit_sha && (
                <span className={styles.commitSha} title={indexJob.commit_sha}>
                  @ {indexJob.commit_sha.slice(0, 7)}
                </span>
              )}
              <button
                type="button"
                className={styles.indexBtn}
                onClick={() => triggerIndex(repoId)}
                disabled={indexingTrigger}
              >
                {indexingTrigger ? 'Starting…' : 'Re-index'}
              </button>
            </div>
          )}
        </form>
      </div>

      <div className={styles.recent}>
        <div className={styles.recentHead}>Recent missions</div>
        {recent?.length === 0 && (
          <div className={styles.muted}>
            {repos?.length === 0 ? (
              <div className={styles.noRepos}>
                <Icon name="repo" size={16} />
                <span>No repositories connected.</span>
                <button
                  type="button"
                  className={styles.indexBtn}
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
                  type="button"
                  className={styles.indexBtn}
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
            ) : (
              'No missions yet — describe one above to get started.'
            )}
          </div>
        )}
        <div className={styles.missionList}>
          {recent.map((m) => (
            <button
              key={m.id}
              className={styles.missionRow}
              onClick={() => navigate(routeTo.mission(m.id) + `?repo=${m.repo_id}`)}
            >
              <Icon name="execution" size={15} className={styles.missionIcon} />
              <span className={styles.missionIntent}>{m.intent}</span>
              <span className={styles.missionRepo}>{repoName(m.repo_id)}</span>
              <StatusBadge map={WORK_ITEM_STATUS} status={m.status} size="sm" />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Console
