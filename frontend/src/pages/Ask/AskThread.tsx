import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '@/components/common'
import { ChatWindow } from '@/features/qa/ChatWindow'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { qaStreamCleared } from '@/store/slices/streamSlice'
import { useSocketChannel } from '@/hooks/useSocketChannel'
import { useAskMutation, useGetSessionQuery } from '@/services/api/qaApi'
import { useListReposQuery } from '@/services/api/repositoryApi'
import { ROUTES } from '@/constants/routes'
import type { QAMessage } from '@/types'

/**
 * A single continuous Ask conversation. Opened from the console the instant a
 * session is created; the first question is handed in via router state and
 * streams immediately, so the transition feels like one uninterrupted chat
 * rather than navigating to a new screen.
 */
export function AskThread() {
  const { id: sessionId = '' } = useParams()
  const [params] = useSearchParams()
  const repoId = params.get('repo') ?? ''
  const location = useLocation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const firstQuestion = (location.state as { firstQuestion?: string } | null)?.firstQuestion
  const sentFirst = useRef(false)

  const { data: repos } = useListReposQuery()
  const repoName = repos?.find((r) => r.id === repoId)?.repo_full_name ?? 'this repository'

  const { data: detail } = useGetSessionQuery(
    { repoId, sessionId },
    { skip: !repoId || !sessionId },
  )
  const [ask, { isLoading: asking }] = useAskMutation()
  const [pending, setPending] = useState<string | null>(null)

  useSocketChannel({
    channel: 'qa',
    resourceId: sessionId,
    path: `/repos/${repoId}/qa/sessions/${sessionId}/stream`,
    enabled: Boolean(repoId && sessionId),
  })
  const live = useAppSelector((s) => (sessionId ? s.stream.qa[sessionId] : undefined))

  const persisted = useMemo(() => detail?.messages ?? [], [detail])
  const busy = asking || Boolean(pending) || (live?.streaming ?? false)

  // Drop the optimistic pair once the persisted answer lands.
  useEffect(() => {
    if (!pending) return
    const last = persisted[persisted.length - 1]
    if (last && last.role === 'assistant') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPending(null)
      dispatch(qaStreamCleared(sessionId))
    }
  }, [persisted, pending, sessionId, dispatch])

  const messages = useMemo<QAMessage[]>(() => {
    const out = [...persisted]
    if (pending) {
      out.push({ id: 'pending-user', role: 'user', content: pending, created_at: '' })
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
  }, [persisted, pending, live])

  async function onAsk(question: string) {
    if (!sessionId) return
    dispatch(qaStreamCleared(sessionId))
    setPending(question)
    try {
      await ask({ repoId, sessionId, question, request_id: crypto.randomUUID() }).unwrap()
    } catch {
      setPending(null)
    }
  }

  // Stream the console's first question immediately — one continuous chat.
  useEffect(() => {
    if (firstQuestion && !sentFirst.current) {
      sentFirst.current = true
      void onAsk(firstQuestion)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstQuestion])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      <header className="flex h-12 flex-shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <button
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          onClick={() => navigate(ROUTES.root)}
        >
          <Icon name="chevronLeft" size={14} /> Console
        </button>
        <span className="h-4 w-px bg-line" />
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          <Icon name="chat" size={15} className="text-primary" /> Ask · {repoName}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ChatWindow repoName={repoName} messages={messages} busy={busy} onAsk={onAsk} />
      </div>
    </div>
  )
}

export default AskThread
