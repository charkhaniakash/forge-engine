import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { terminalCreated } from '@/store/slices/workspaceTerminalSlice'
import {
  useCloseTerminalMutation,
  useCreateTerminalMutation,
} from '@/services/api/workspaceEditorApi'
import { workspaceSocket } from '@/services/workspace/WorkspaceSocket'
import styles from './workspace.module.css'

/**
 * xterm.js terminal wired to the workspace container over the multiplexed
 * socket. The backend session is created LAZILY — only once the panel is
 * actually visible and sized — so we never open a 0-size terminal (which xterm
 * would size to a useless ~9x8 grid) or spin one up for a tab the user hasn't
 * opened. The session is closed on unmount.
 */
export function TerminalPanel({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const dispatch = useAppDispatch()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const writtenRef = useRef(0)
  const startedRef = useRef(false)

  const [createTerminal] = useCreateTerminalMutation()
  const [closeTerminal] = useCloseTerminalMutation()
  const activeTerminalId = useAppSelector((s) => s.workspaceTerminal.activeTerminalId)
  const output = useAppSelector((s) =>
    activeTerminalId ? s.workspaceTerminal.output[activeTerminalId] ?? [] : [],
  )

  // Boot xterm + backend session once, only when the panel is visible & sized.
  useEffect(() => {
    if (!active || startedRef.current) return
    const el = containerRef.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    startedRef.current = true

    const term = new Terminal({
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#1e1e1e' },
      convertEol: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const id = terminalIdRef.current
      if (id) workspaceSocket.send('terminal', 'input', { terminal_id: id, data })
    })

    void (async () => {
      try {
        const session = await createTerminal({
          workspaceId,
          cols: term.cols || 80,
          rows: term.rows || 24,
        }).unwrap()
        terminalIdRef.current = session.id
        dispatch(terminalCreated({ id: session.id, status: session.status }))
      } catch {
        term.writeln('\x1b[31mFailed to start terminal session.\x1b[0m')
      }
    })()

    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // xterm throws on a 0-size element (hidden tab) — ignore.
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      const id = terminalIdRef.current
      if (id) {
        void closeTerminal({ workspaceId, terminalId: id }).catch(() => {})
        terminalIdRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      writtenRef.current = 0
      startedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId])

  // Refit whenever the panel becomes visible again.
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
        } catch {
          /* ignore */
        }
      })
    }
  }, [active])

  // Stream new output chunks into xterm (only those not yet written).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    for (let i = writtenRef.current; i < output.length; i++) {
      term.write(output[i])
    }
    writtenRef.current = output.length
  }, [output])

  return <div ref={containerRef} className={styles.terminalWrap} />
}
