/**
 * LivePreview — embedded browser preview panel, Vercel v0-style.
 *
 * Renders the running application in an iframe via the backend proxy:
 *   /v1/workspace/:id/preview/proxy/*
 *
 * State machine (driven by the `preview` WS channel):
 *   idle → starting → compiling → ready (iframe) → error / stopped
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { Icon, Spinner } from '@/components/common'
import { useStartPreviewMutation, useStopPreviewMutation } from '@/services/api/workspaceEditorApi'
import { previewReset } from '@/store/slices/workspaceActivitySlice'
import { BACKEND_URL } from '@/constants/config'
import { cn } from '@/lib/utils'

interface LivePreviewProps {
  workspaceId: string
  /** When collapsed the iframe is kept mounted but hidden (preserves state). */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

const STATUS_META: Record<string, { dot: string; text: string; label: string }> = {
  idle:      { dot: 'bg-fg-subtle',   text: 'text-fg-subtle',   label: 'Not started' },
  starting:  { dot: 'bg-info',        text: 'text-info',        label: 'Starting…' },
  compiling: { dot: 'bg-warning',     text: 'text-warning',     label: 'Compiling…' },
  ready:     { dot: 'bg-success',     text: 'text-success',     label: 'Live' },
  error:     { dot: 'bg-destructive', text: 'text-destructive', label: 'Error' },
  stopped:   { dot: 'bg-fg-subtle',   text: 'text-fg-subtle',   label: 'Stopped' },
}

const iconBtn =
  'flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40'

export function LivePreview({ workspaceId, collapsed, onToggleCollapse }: LivePreviewProps) {
  const dispatch = useAppDispatch()
  const preview = useAppSelector((s) => s.workspaceActivity.preview)
  const [startPreview, { isLoading: starting }] = useStartPreviewMutation()
  const [stopPreview] = useStopPreviewMutation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeError, setIframeError] = useState(false)
  const [addressBarUrl, setAddressBarUrl] = useState('/')
  const [showAddressBar, setShowAddressBar] = useState(false)

  const proxyBase = `${BACKEND_URL}/v1/workspace/${workspaceId}/preview/proxy`
  const iframeSrc = `${proxyBase}${addressBarUrl}`

  // On HMR update: reload the iframe instead of full re-mount when possible.
  const prevReloadKey = useRef(preview.reloadKey)
  useEffect(() => {
    if (preview.reloadKey === prevReloadKey.current) return
    prevReloadKey.current = preview.reloadKey
    const iframe = iframeRef.current
    if (!iframe) return
    try {
      iframe.contentWindow?.postMessage({ type: 'forge:reload' }, '*')
    } catch {
      /* cross-origin — fall back to src reassignment */
    }
    const t = setTimeout(() => {
      if (iframeRef.current) {
        const url = new URL(iframeSrc, window.location.origin)
        url.searchParams.set('_r', String(Date.now()))
        iframeRef.current.src = url.toString()
      }
    }, 300)
    return () => clearTimeout(t)
  }, [preview.reloadKey, iframeSrc])

  useEffect(() => {
    if (preview.status === 'ready') setIframeError(false)
  }, [preview.status])

  const handleStart = useCallback(async () => {
    if (!workspaceId) {
      console.warn('[LivePreview] start skipped — no workspaceId')
      return
    }
    setIframeError(false)
    try {
      await startPreview({ workspaceId }).unwrap()
    } catch (e: unknown) {
      console.warn('[LivePreview] startPreview failed:', e)
    }
  }, [workspaceId, startPreview])

  const handleStop = useCallback(async () => {
    try {
      await stopPreview(workspaceId).unwrap()
      dispatch(previewReset())
    } catch {
      /* ignore */
    }
  }, [workspaceId, stopPreview, dispatch])

  const handleRefresh = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    setIframeError(false)
    iframe.src = iframeSrc + '?_r=' + Date.now()
  }, [iframeSrc])

  const handleNavigate = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setIframeError(false)
    const iframe = iframeRef.current
    if (iframe) iframe.src = `${proxyBase}${addressBarUrl}`
  }, [proxyBase, addressBarUrl])

  // ── Derived display state ───────────────────────────────────────────────
  const { status } = preview
  const isRunning = status === 'ready' || status === 'compiling'
  const isLoading = status === 'starting' || (starting && status === 'idle')
  const hasError = status === 'error' || iframeError
  const meta = STATUS_META[status] ?? STATUS_META.idle

  const StateScreen = ({ icon, title, subtitle, action, danger }: {
    icon: React.ReactNode
    title: string
    subtitle?: string
    action?: React.ReactNode
    danger?: boolean
  }) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className={cn('flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface-2', danger ? 'text-destructive' : 'text-fg-subtle')}>
        {icon}
      </div>
      <p className="text-sm font-semibold text-fg-muted">{title}</p>
      {subtitle && <span className="max-w-xs text-xs leading-relaxed text-fg-subtle">{subtitle}</span>}
      {action}
    </div>
  )

  const startFullBtn = (label: string) => (
    <button
      className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={handleStart}
      disabled={!workspaceId}
      title={workspaceId ? undefined : 'No workspace available'}
    >
      <Icon name="play" size={14} /> {label}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-collapsed={collapsed}>
      {/* Header bar */}
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
        <div className="flex items-center gap-1">
          {onToggleCollapse && (
            <button className={iconBtn} onClick={onToggleCollapse} title={collapsed ? 'Show preview' : 'Hide preview'}>
              <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={13} />
            </button>
          )}
          <span className="flex items-center gap-1.5 px-1 text-xs font-medium text-fg-muted">
            <Icon name="monitor" size={13} /> Preview
          </span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center">
          {showAddressBar && isRunning ? (
            <form onSubmit={handleNavigate} className="flex w-full max-w-sm items-center gap-1">
              <input
                className="min-w-0 flex-1 rounded-md border border-border bg-base px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-primary/40"
                value={addressBarUrl}
                onChange={(e) => setAddressBarUrl(e.target.value)}
                placeholder="/"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className={iconBtn} title="Go">
                <Icon name="chevronRight" size={12} />
              </button>
            </form>
          ) : (
            <button
              className="max-w-xs truncate rounded-md border border-border bg-base px-2.5 py-1 font-mono text-[11px] text-fg-subtle transition-colors hover:text-fg-muted disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => setShowAddressBar((v) => !v)}
              title="Navigate to path"
              disabled={!isRunning}
            >
              {isRunning ? `localhost:${preview.port ?? '…'}${addressBarUrl}` : '—'}
            </button>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <span className="flex items-center gap-1.5 px-1 font-mono text-[11px]" title={preview.lastMessage ?? meta.label}>
            <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot, isRunning && 'animate-pulse')} />
            <span className={meta.text}>{meta.label}</span>
          </span>
          {isRunning && (
            <button className={iconBtn} onClick={handleRefresh} title="Refresh">
              <Icon name="refresh" size={13} />
            </button>
          )}
          {isRunning ? (
            <button className={iconBtn} onClick={handleStop} title="Stop dev server">
              <Icon name="stop" size={13} />
            </button>
          ) : status !== 'starting' && (
            <button
              className={cn(iconBtn, 'text-primary hover:text-primary')}
              onClick={handleStart}
              disabled={isLoading || !workspaceId}
              title={workspaceId ? 'Start dev server' : 'No workspace available'}
            >
              {isLoading ? <Spinner size={12} /> : <Icon name="play" size={13} />}
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      {!collapsed && (
        <div className="relative min-h-0 flex-1 bg-white">
          {status === 'compiling' && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-base/80 text-fg-muted backdrop-blur-sm">
              <Spinner size={20} />
              <span className="text-xs">Compiling…</span>
            </div>
          )}

          {isLoading && (
            <div className="absolute inset-0 bg-base">
              <StateScreen icon={<Spinner size={28} />} title="Starting development server" subtitle="Auto-detecting stack and launching dev server…" />
            </div>
          )}

          {hasError && !isLoading && (
            <div className="absolute inset-0 bg-base">
              <StateScreen
                danger
                icon={<Icon name="alertCircle" size={32} />}
                title={iframeError ? 'Preview failed to load' : 'Build error'}
                subtitle={preview.errorMessage ?? 'Check the terminal for details'}
                action={
                  <button className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-2" onClick={handleStart}>
                    <Icon name="refresh" size={13} /> Retry
                  </button>
                }
              />
            </div>
          )}

          {status === 'idle' && !isLoading && (
            <div className="absolute inset-0 bg-base">
              <StateScreen icon={<Icon name="monitor" size={36} />} title="No preview running" subtitle="Start the dev server to see your app update live as files change" action={startFullBtn('Start preview')} />
            </div>
          )}

          {status === 'stopped' && !isLoading && (
            <div className="absolute inset-0 bg-base">
              <StateScreen icon={<Icon name="stop" size={32} />} title="Dev server stopped" action={startFullBtn('Restart preview')} />
            </div>
          )}

          {(status === 'ready' || status === 'compiling') && !hasError && (
            <iframe
              ref={iframeRef}
              key={`preview-${workspaceId}`}
              src={iframeSrc}
              className="h-full w-full border-0 bg-white"
              title="Live Preview"
              onLoad={() => setIframeError(false)}
              onError={() => setIframeError(true)}
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-pointer-lock"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      )}
    </div>
  )
}
