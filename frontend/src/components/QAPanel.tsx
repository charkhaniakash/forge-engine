/**
 * QAPanel — Phase 4 Q&A interface for an indexed repository.
 *
 * Rendered when a repo has index status = 'done'.
 * Features:
 *   - Session list (left) + chat view (right)
 *   - WebSocket connection for real-time token streaming
 *   - Rich citation display (file + line range)
 *   - Graceful fallback when WebSocket is unavailable (answer still
 *     arrives in the POST /ask response body)
 */

import { useEffect, useRef, useState } from 'react'

const API = 'http://localhost:8080'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Citation {
  chunk_id: string
  commit_sha: string
  file_path: string
  start_line: number
  end_line: number
  language?: string
  chunk_type?: string
  symbol_name?: string
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  model?: string
  token_count?: number
  created_at: string
  // Transient — used for streaming
  streaming?: boolean
}

interface Session {
  id: string
  repo_id: string
  commit_sha: string
  title?: string
  created_at: string
}

interface QAPanelProps {
  repoID: string
  repoName: string
  token: string
}

// ── Main component ────────────────────────────────────────────────────────────

export function QAPanel({ repoID, repoName, token }: QAPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)

  // WebSocket for token streaming
  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load sessions when panel mounts
  useEffect(() => {
    loadSessions()
    return () => wsRef.current?.close()
  }, [repoID])

  // Open WebSocket when active session changes
  useEffect(() => {
    wsRef.current?.close()
    if (!activeSession) return

    // Browsers do not support custom headers on WebSocket connections.
    // Pass the JWT as a query parameter — the Go handler reads it from ?token=.
    const wsURL = `ws://localhost:8080/v1/repos/${repoID}/qa/sessions/${activeSession.id}/stream?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(wsURL)

    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data)
        handleStreamEvent(event)
      } catch (_) {}
    }

    ws.onerror = () => {
      // WS unavailable — the answer will still arrive in the POST response body
    }

    wsRef.current = ws
    return () => ws.close()
  }, [activeSession?.id])

  const handleStreamEvent = (event: any) => {
    if (event.event === 'token') {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.streaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + event.text },
          ]
        }
        // Create a new streaming assistant message
        return [
          ...prev,
          {
            id: `streaming-${event.request_id}`,
            role: 'assistant',
            content: event.text,
            created_at: new Date().toISOString(),
            streaming: true,
          },
        ]
      })
    }

    if (event.event === 'done') {
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.streaming) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              streaming: false,
              citations: event.citations ?? [],
              model: event.model,
              token_count: event.token_count,
            },
          ]
        }
        return prev
      })
    }
  }

  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/qa/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) setSessions(data.sessions ?? [])
    } finally {
      setLoadingSessions(false)
    }
  }

  const createSession = async () => {
    setError(null)
    const res = await fetch(`${API}/v1/repos/${repoID}/qa/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'Failed to create session')
      return
    }
    setSessions((prev) => [data, ...prev])
    await openSession(data)
  }

  const openSession = async (session: Session) => {
    setActiveSession(session)
    setMessages([])
    setError(null)
    try {
      const res = await fetch(`${API}/v1/repos/${repoID}/qa/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok) setMessages(data.messages ?? [])
    } catch (_) {}
  }

  const ask = async () => {
    if (!activeSession || !question.trim() || asking) return

    const q = question.trim()
    setQuestion('')
    setError(null)
    setAsking(true)

    // Optimistically add the user message
    const userMsg: Message = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: q,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])

    const requestID = crypto.randomUUID()

    try {
      const res = await fetch(
        `${API}/v1/repos/${repoID}/qa/sessions/${activeSession.id}/ask`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ question: q, request_id: requestID }),
        }
      )
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to get answer')
        return
      }

      // If WebSocket wasn't streaming (WS unavailable / slow), replace the
      // streaming placeholder with the final persisted message.
      if (data.message) {
        setMessages((prev) => {
          const withoutStreaming = prev.filter((m) => !m.streaming)
          return [...withoutStreaming, data.message]
        })
      }

      // Refresh session list to update title
      loadSessions()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setAsking(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '500px', border: '1px solid #d0d7de', borderRadius: '6px', overflow: 'hidden', fontFamily: 'sans-serif', fontSize: '14px' }}>
      {/* Session list */}
      <div style={{ width: '220px', borderRight: '1px solid #d0d7de', display: 'flex', flexDirection: 'column', background: '#f6f8fa' }}>
        <div style={{ padding: '10px', borderBottom: '1px solid #d0d7de', fontWeight: 600 }}>
          Sessions
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingSessions && <div style={{ padding: '8px', color: '#57606a' }}>Loading…</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => openSession(s)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                border: 'none',
                background: activeSession?.id === s.id ? '#dbeafe' : 'transparent',
                cursor: 'pointer',
                borderBottom: '1px solid #e1e4e8',
                fontSize: '13px',
              }}
            >
              <div style={{ fontWeight: 500, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {s.title ?? 'New session'}
              </div>
              <div style={{ fontSize: '11px', color: '#57606a' }}>
                {s.commit_sha.slice(0, 7)} · {new Date(s.created_at).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
        <div style={{ padding: '8px', borderTop: '1px solid #d0d7de' }}>
          <button
            onClick={createSession}
            style={{ width: '100%', padding: '6px', background: '#0969da', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            + New session
          </button>
        </div>
      </div>

      {/* Chat view */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #d0d7de', background: '#f6f8fa' }}>
          <strong>Ask about</strong> {repoName}
          {activeSession && (
            <span style={{ marginLeft: '8px', fontSize: '12px', color: '#57606a' }}>
              · {activeSession.commit_sha.slice(0, 7)}
            </span>
          )}
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!activeSession && (
            <div style={{ color: '#57606a', textAlign: 'center', marginTop: '60px' }}>
              Create or select a session to start asking questions.
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          {error && (
            <div style={{ color: '#cf222e', fontSize: '13px', padding: '8px', background: '#ffebe9', borderRadius: '4px' }}>
              {error}
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid #d0d7de', display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && ask()}
            placeholder={activeSession ? 'Ask a question about this codebase…' : 'Select a session first'}
            disabled={!activeSession || asking}
            style={{ flex: 1, padding: '8px', border: '1px solid #d0d7de', borderRadius: '4px', fontSize: '14px' }}
          />
          <button
            onClick={ask}
            disabled={!activeSession || asking || !question.trim()}
            style={{ padding: '8px 14px', background: '#0969da', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {asking ? '…' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '80%',
          padding: '8px 12px',
          borderRadius: '8px',
          background: isUser ? '#0969da' : '#f6f8fa',
          color: isUser ? '#fff' : '#1f2328',
          border: isUser ? 'none' : '1px solid #d0d7de',
          whiteSpace: 'pre-wrap',
          lineHeight: '1.5',
        }}
      >
        {msg.content}
        {msg.streaming && <span style={{ opacity: 0.5 }}>▌</span>}
      </div>

      {!isUser && msg.citations && msg.citations.length > 0 && (
        <div style={{ marginTop: '6px', maxWidth: '80%', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {msg.citations.map((c) => (
            <CitationTag key={c.chunk_id} citation={c} />
          ))}
        </div>
      )}

      {!isUser && msg.model && (
        <div style={{ fontSize: '11px', color: '#57606a', marginTop: '3px' }}>
          {msg.model} · {msg.token_count ?? 0} tokens
        </div>
      )}
    </div>
  )
}

// ── CitationTag ───────────────────────────────────────────────────────────────

function CitationTag({ citation }: { citation: Citation }) {
  const label = citation.symbol_name
    ? `${citation.symbol_name} (${citation.file_path.split('/').pop()}:${citation.start_line})`
    : `${citation.file_path.split('/').pop()}:${citation.start_line}–${citation.end_line}`

  return (
    <span
      title={`${citation.file_path}:${citation.start_line}–${citation.end_line}`}
      style={{
        fontSize: '11px',
        padding: '2px 6px',
        background: '#dbeafe',
        color: '#1d4ed8',
        borderRadius: '10px',
        cursor: 'default',
        border: '1px solid #bfdbfe',
      }}
    >
      {label}
    </span>
  )
}
