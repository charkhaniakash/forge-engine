import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppSelector } from '@/app/hooks'

/**
 * Read-only live feed of the agent's command output (install / build / test /
 * lint). The backend already streams each stage's stdout/stderr as
 * `diagnostics.stage_output` chunks; useWorkspaceSocket accumulates them into
 * `workspaceActivity.output`, and this panel renders them with ANSI colors via
 * xterm, exactly as they'd look in a real terminal. Not interactive — the
 * separate Terminal panel is for typing commands.
 */
export function OutputPanel({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writtenRef = useRef(0)
  const startedRef = useRef(false)

  const output = useAppSelector((s) => s.workspaceActivity.output)

  useEffect(() => {
    if (startedRef.current) return
    const el = containerRef.current
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    startedRef.current = true

    const term = new Terminal({
      fontFamily: 'var(--font-mono), monospace',
      fontSize: 12,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      theme: { background: '#1e1e1e' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    if (output.length === 0) {
      term.writeln('\x1b[90mNo command output yet. Build / test / lint output streams here live when the agent runs.\x1b[0m')
    }

    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* zero-size while hidden — ignore */
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      writtenRef.current = 0
      startedRef.current = false
    }
    // output is read once for the initial hint; it must NOT be a dep or the
    // terminal would be disposed/recreated on every chunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Write only the chunks not yet written. A shrink (new run reset the buffer)
  // clears the terminal and replays from the start.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (output.length < writtenRef.current) {
      term.clear()
      writtenRef.current = 0
    }
    for (let i = writtenRef.current; i < output.length; i++) {
      term.write(output[i])
    }
    writtenRef.current = output.length
  }, [output])

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

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-inset p-1" />
}
