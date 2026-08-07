import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon, Spinner } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { CitationCard } from './CitationCard'
import type { Citation, QAMessage } from '@/types'
import { cn } from '@/lib/utils'

export interface ChatWindowProps {
  repoName: string
  commitSha?: string
  messages: QAMessage[]
  busy: boolean
  disabled?: boolean
  onAsk: (question: string) => void
  onCitationClick?: (c: Citation) => void
}

export function ChatWindow({
  repoName,
  commitSha,
  messages,
  busy,
  disabled = false,
  onAsk,
  onCitationClick,
}: ChatWindowProps) {
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow streaming answers only while the user is parked at the bottom.
  useEffect(() => {
    if (pinnedRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  function submit() {
    const q = text.trim()
    if (!q || busy || disabled) return
    onAsk(q)
    setText('')
    pinnedRef.current = true
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle">
                <Icon name="chat" size={28} />
              </div>
              <div className="text-sm font-medium text-fg">Ask anything about {repoName}</div>
              <span className="text-[13px] text-fg-subtle">Answers cite the exact files and lines they draw from.</span>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} onCitationClick={onCitationClick} />
          ))}
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-line bg-base px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            className="max-h-40 min-h-11 flex-1 resize-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={disabled ? 'Select or create a session first' : 'Ask a question…'}
            disabled={disabled}
          />
          <Button onClick={submit} disabled={disabled || busy || !text.trim()}>
            {busy ? <Spinner size={14} /> : 'Ask'}
          </Button>
        </div>
        {commitSha && (
          <div className="mx-auto mt-2 max-w-3xl font-mono text-[11px] text-fg-subtle">
            Answering against {commitSha.slice(0, 7)}
          </div>
        )}
      </div>
    </div>
  )
}

function MessageBubble({
  msg,
  onCitationClick,
}: {
  msg: QAMessage
  onCitationClick?: (c: Citation) => void
}) {
  const isUser = msg.role === 'user'
  return (
    <div className={cn('flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed',
          isUser
            ? 'rounded-br-sm border border-primary/20 bg-primary/10 text-fg'
            : 'rounded-bl-sm border border-border bg-card text-fg-muted',
        )}
      >
        {msg.content}
        {msg.streaming && <span className="ml-0.5 inline-block animate-pulse text-primary">▌</span>}
      </div>
      {!isUser && msg.citations && msg.citations.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap gap-1.5">
          {msg.citations.map((c) => (
            <CitationCard key={c.chunk_id} citation={c} onClick={onCitationClick} />
          ))}
        </div>
      )}
      {!isUser && msg.model && (
        <div className="font-mono text-[11px] text-fg-subtle">
          {msg.model} · {msg.token_count ?? 0} tokens
        </div>
      )}
    </div>
  )
}
