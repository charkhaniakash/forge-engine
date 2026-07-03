import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Icon } from '@/components/common'
import { CitationCard } from './CitationCard'
import type { Citation, QAMessage } from '@/types'
import styles from './ChatWindow.module.css'

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
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function submit() {
    const q = text.trim()
    if (!q || busy || disabled) return
    onAsk(q)
    setText('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={styles.window}>
      <div className={styles.messages}>
        {messages.length === 0 && (
          <div className={styles.placeholder}>
            <Icon name="chat" size={28} />
            <div>Ask anything about {repoName}</div>
            <span>Answers cite the exact files and lines they draw from.</span>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} onCitationClick={onCitationClick} />
        ))}
        <div ref={endRef} />
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={disabled ? 'Select or create a session first' : 'Ask a question…'}
          disabled={disabled}
        />
        <Button variant="primary" onClick={submit} loading={busy} disabled={disabled || !text.trim()}>
          Ask
        </Button>
      </div>
      {commitSha && <div className={styles.commit}>Answering against {commitSha.slice(0, 7)}</div>}
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
    <div className={`${styles.turn} ${isUser ? styles.user : styles.assistant}`}>
      <div className={styles.bubble}>
        {msg.content}
        {msg.streaming && <span className={styles.caret}>▌</span>}
      </div>
      {!isUser && msg.citations && msg.citations.length > 0 && (
        <div className={styles.citations}>
          {msg.citations.map((c) => (
            <CitationCard key={c.chunk_id} citation={c} onClick={onCitationClick} />
          ))}
        </div>
      )}
      {!isUser && msg.model && (
        <div className={styles.meta}>
          {msg.model} · {msg.token_count ?? 0} tokens
        </div>
      )}
    </div>
  )
}
