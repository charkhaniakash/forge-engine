import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button,
  Drawer,
  EmptyState,
  Icon,
  Spinner,
} from '@/components/common'
import { ChatWindow } from '@/features/qa/ChatWindow'
import { CitationCard } from '@/features/qa/CitationCard'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { qaStreamCleared } from '@/store/slices/streamSlice'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useToast } from '@/hooks/useToast'
import {
  useAskMutation,
  useCreateSessionMutation,
  useGetSessionQuery,
  useListSessionsQuery,
} from '@/services/api/qaApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { routeTo } from '@/constants/routes'
import type { Citation, QAMessage } from '@/types'
import styles from './RepositoryQA.module.css'

export function RepositoryQA() {
  const { id: repoId = '' } = useParams()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const toast = useToast()

  const { data: repos } = useListReposQuery()
  const repo = repos?.find((r) => r.id === repoId)

  const { data: sessions = [], isLoading: sessionsLoading } = useListSessionsQuery(repoId)
  // Default to the newest session until the user explicitly selects one.
  const [picked, setPicked] = useState<string | null>(null)
  const activeId = picked ?? sessions[0]?.id ?? null
  const setActiveId = setPicked
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [citation, setCitation] = useState<Citation | null>(null)

  const [createSession, { isLoading: creating }] = useCreateSessionMutation()
  const [ask, { isLoading: asking }] = useAskMutation()

  const { data: detail, isFetching: loadingMessages } = useGetSessionQuery(
    { repoId, sessionId: activeId ?? '' },
    { skip: !activeId },
  )

  // Live token stream for the active session.
  useSocketChannel({
    channel: 'qa',
    resourceId: activeId,
    path: `/repos/${repoId}/qa/sessions/${activeId}/stream`,
    enabled: Boolean(activeId),
  })
  const live = useAppSelector((s) => (activeId ? s.stream.qa[activeId] : undefined))

  const persisted = useMemo(() => detail?.messages ?? [], [detail])

  // Once the refetched session ends with an assistant answer, drop the
  // optimistic + live bubbles.
  useEffect(() => {
    if (!pendingQuestion) return
    const last = persisted[persisted.length - 1]
    if (last && last.role === 'assistant') {
      // Reset transient optimistic state once the real answer is persisted.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingQuestion(null)
      if (activeId) dispatch(qaStreamCleared(activeId))
    }
  }, [persisted, pendingQuestion, activeId, dispatch])

  const busy = asking || Boolean(pendingQuestion) || (live?.streaming ?? false)

  const messages = useMemo<QAMessage[]>(() => {
    const out = [...persisted]
    if (pendingQuestion) {
      out.push({
        id: 'pending-user',
        role: 'user',
        content: pendingQuestion,
        created_at: '',
      })
      out.push({
        id: 'live-assistant',
        role: 'assistant',
        content: live?.text ?? '',
        streaming: live?.streaming ?? true,
        citations: live?.citations,
        model: live?.model,
        token_count: live?.tokenCount,
        created_at: '',
      })
    }
    return out
  }, [persisted, pendingQuestion, live])

  async function onCreate() {
    try {
      const session = await createSession(repoId).unwrap()
      setActiveId(session.id)
    } catch {
      toast.error('Could not create session')
    }
  }

  async function onAsk(question: string) {
    if (!activeId) return
    dispatch(qaStreamCleared(activeId))
    setPendingQuestion(question)
    try {
      await ask({
        repoId,
        sessionId: activeId,
        question,
        request_id: crypto.randomUUID(),
      }).unwrap()
    } catch {
      toast.error('Failed to get an answer')
      setPendingQuestion(null)
    }
  }

  const activeSession = sessions.find((s) => s.id === activeId)

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <span>Sessions</span>
          <Button
            size="sm"
            variant="subtle"
            iconOnly
            onClick={onCreate}
            loading={creating}
            leadingIcon={<Icon name="plus" size={15} />}
            aria-label="New session"
          />
        </div>
        <div className={styles.sessionList}>
          {sessionsLoading && (
            <div className={styles.loading}>
              <Spinner size={16} />
            </div>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <div className={styles.noSessions}>No sessions yet</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`${styles.session} ${s.id === activeId ? styles.sessionActive : ''}`}
              onClick={() => setActiveId(s.id)}
            >
              <div className={styles.sessionTitle}>{s.title ?? 'New session'}</div>
              <div className={styles.sessionMeta}>
                {s.commit_sha.slice(0, 7)} · {new Date(s.created_at).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.main}>
        <header className={styles.header}>
          <div>
            <button className={styles.backLink} onClick={() => navigate(routeTo.repository(repoId))}>
              <Icon name="chevronLeft" size={14} /> {repo?.repo_full_name ?? 'Repository'}
            </button>
            <h1 className={styles.title}>Repository Q&amp;A</h1>
          </div>
        </header>

        {!activeId ? (
          <EmptyState
            icon={<Icon name="chat" size={36} />}
            title="Start a conversation"
            description="Create a session to ask questions grounded in this repository's code."
            action={
              <Button variant="primary" onClick={onCreate} loading={creating}>
                New session
              </Button>
            }
          />
        ) : (
          <div className={styles.chat}>
            {loadingMessages && persisted.length === 0 && !pendingQuestion ? (
              <div className={styles.loading}>
                <Spinner size={20} />
              </div>
            ) : (
              <ChatWindow
                repoName={repo?.repo_full_name ?? 'this repository'}
                commitSha={activeSession?.commit_sha}
                messages={messages}
                busy={busy}
                onAsk={onAsk}
                onCitationClick={setCitation}
              />
            )}
          </div>
        )}
      </section>

      <Drawer
        open={Boolean(citation)}
        onClose={() => setCitation(null)}
        title="Citation"
        width={520}
      >
        {citation && (
          <div className={styles.citationDetail}>
            <CitationCard citation={citation} variant="row" />
            <dl className={styles.citationMeta}>
              <div>
                <dt>File</dt>
                <dd className={styles.mono}>{citation.file_path}</dd>
              </div>
              <div>
                <dt>Lines</dt>
                <dd className={styles.mono}>
                  {citation.start_line}–{citation.end_line}
                </dd>
              </div>
              {citation.symbol_name && (
                <div>
                  <dt>Symbol</dt>
                  <dd className={styles.mono}>{citation.symbol_name}</dd>
                </div>
              )}
              {citation.language && (
                <div>
                  <dt>Language</dt>
                  <dd>{citation.language}</dd>
                </div>
              )}
              <div>
                <dt>Commit</dt>
                <dd className={styles.mono}>{citation.commit_sha.slice(0, 12)}</dd>
              </div>
            </dl>
            <p className={styles.note}>
              Inline source preview lands with the browser workspace (Phase 10B).
            </p>
          </div>
        )}
      </Drawer>
    </div>
  )
}

export default RepositoryQA
