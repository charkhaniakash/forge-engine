/**
 * LivePreview — embedded browser preview panel, Vercel v0-style.
 *
 * Renders the running application in an iframe via the backend proxy:
 *   /v1/workspace/:id/preview/proxy/*
 *
 * State machine (driven by the `preview` WS channel):
 *   idle      → user clicks "Start preview"
 *   starting  → dev server process spawning
 *   compiling → server up, recompiling after a file change
 *   ready     → iframe shown; HMR events increment reloadKey
 *   error     → build/runtime error shown inline
 *   stopped   → user or system stopped the server
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { Icon, Spinner } from '@/components/common'
import { useStartPreviewMutation, useStopPreviewMutation } from '@/services/api/workspaceEditorApi'
import { previewReset } from '@/store/slices/workspaceActivitySlice'
import { BACKEND_URL } from '@/constants/config'
import styles from './LivePreview.module.css'

interface LivePreviewProps {
  workspaceId: string
  /** When collapsed the iframe is kept mounted but hidden (preserves state). */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function LivePreview({ workspaceId, collapsed, onToggleCollapse }: LivePreviewProps) {
  const dispatch = useAppDispatch()
  const preview = useAppSelector((s) => s.workspaceActivity.preview)
  const [startPreview, { isLoading: starting }] = useStartPreviewMutation()
  const [stopPreview] = useStopPreviewMutation()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeError, setIframeError] = useState(false)
  const [addressBarUrl, setAddressBarUrl] = useState('/')
  const [showAddressBar, setShowAddressBar] = useState(false)

  // Build the full proxy URL for the iframe src
  const proxyBase = `${BACKEND_URL}/v1/workspace/${workspaceId}/preview/proxy`
  const iframeSrc = `${proxyBase}${addressBarUrl}`

  // On HMR update: reload the iframe instead of full re-mount when possible
  const prevReloadKey = useRef(preview.reloadKey)
  useEffect(() => {
    if (preview.reloadKey === prevReloadKey.current) return
    prevReloadKey.current = preview.reloadKey
    const iframe = iframeRef.current
    if (!iframe) return
    // Try postMessage reload first (faster, no flash)
    try {
      iframe.contentWindow?.postMessage({ type: 'forge:reload' }, '*')
    } catch {
      // If cross-origin or blocked, fall back to src reassignment
    }
    // Delay the src bump so the postMessage has a chance to be handled first
    const t = setTimeout(() => {
      if (iframeRef.current) {
        // Toggle a cache-buster on the src to force a reload
        const url = new URL(iframeSrc, window.location.origin)
        url.searchParams.set('_r', String(Date.now()))
        iframeRef.current.src = url.toString()
      }
    }, 300)
    return () => clearTimeout(t)
  }, [preview.reloadKey, iframeSrc])

  // When status goes ready, clear any iframe error flag
  useEffect(() => {
    if (preview.status === 'ready') setIframeError(false)
  }, [preview.status])

  const handleStart = useCallback(async () => {
    // Guard: an empty workspaceId produces /v1/workspace//preview/start (404).
    // The panel is only mounted with a real ID now, but keep the guard so a
    // stale state can never fire a broken request.
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

  const statusColor = {
    idle: 'var(--text-tertiary)',
    starting: 'var(--info)',
    compiling: 'var(--warning)',
    ready: 'var(--success)',
    error: 'var(--danger)',
    stopped: 'var(--text-tertiary)',
  }[status] ?? 'var(--text-tertiary)'

  const statusLabel = {
    idle: 'Not started',
    starting: 'Starting…',
    compiling: 'Compiling…',
    ready: 'Live',
    error: 'Error',
    stopped: 'Stopped',
  }[status] ?? status

  return (
    <div className={styles.root} data-collapsed={collapsed}>
      {/* ── Header bar ────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.iconBtn}
            onClick={onToggleCollapse}
            title={collapsed ? 'Show preview' : 'Hide preview'}
          >
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={13} />
          </button>
          <span className={styles.title}>
            <Icon name="monitor" size={13} />
            Preview
          </span>
        </div>

        <div className={styles.headerCenter}>
          {showAddressBar && isRunning ? (
            <form onSubmit={handleNavigate} className={styles.addressForm}>
              <input
                className={styles.addressInput}
                value={addressBarUrl}
                onChange={(e) => setAddressBarUrl(e.target.value)}
                placeholder="/"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className={styles.iconBtn} title="Go">
                <Icon name="chevronRight" size={12} />
              </button>
            </form>
          ) : (
            <button
              className={styles.urlChip}
              onClick={() => setShowAddressBar((v) => !v)}
              title="Navigate to path"
              disabled={!isRunning}
            >
              {isRunning ? `localhost:${preview.port ?? '…'}${addressBarUrl}` : '—'}
            </button>
          )}
        </div>

        <div className={styles.headerRight}>
          {/* Status indicator */}
          <span className={styles.statusChip} title={preview.lastMessage ?? statusLabel}>
            <span className={styles.statusDot} style={{ background: statusColor,
              animation: (status === 'ready' || status === 'compiling') ? 'lp-pulse 1.8s ease infinite' : 'none' }} />
            <span style={{ color: statusColor }}>{statusLabel}</span>
          </span>

          {/* Controls */}
          {isRunning && (
            <button className={styles.iconBtn} onClick={handleRefresh} title="Refresh">
              <Icon name="refresh" size={13} />
            </button>
          )}
          {isRunning ? (
            <button className={styles.iconBtn} onClick={handleStop} title="Stop dev server">
              <Icon name="stop" size={13} />
            </button>
          ) : status !== 'starting' && (
            <button
              className={`${styles.iconBtn} ${styles.startBtn}`}
              onClick={handleStart}
              disabled={isLoading || !workspaceId}
              title={workspaceId ? 'Start dev server' : 'No workspace available'}
            >
              {isLoading ? <Spinner size={12} /> : <Icon name="play" size={13} />}
            </button>
          )}
        </div>
      </div>

      {/* ── Content area ──────────────────────────────────────────────── */}
      {!collapsed && (
        <div className={styles.body}>
          {/* Compiling overlay — shown over the iframe without unmounting it */}
          {status === 'compiling' && (
            <div className={styles.overlay}>
              <Spinner size={20} />
              <span>Compiling…</span>
            </div>
          )}

          {/* Starting / loading state */}
          {isLoading && (
            <div className={styles.stateScreen}>
              <div className={styles.stateIcon}>
                <Spinner size={28} />
              </div>
              <p className={styles.stateTitle}>Starting Development Server</p>
              <span className={styles.stateSubtitle}>
                Auto-detecting stack and launching dev server…
              </span>
            </div>
          )}

          {/* Error state */}
          {hasError && !isLoading && (
            <div className={styles.stateScreen}>
              <div className={styles.stateIcon} style={{ color: 'var(--danger)' }}>
                <Icon name="alertCircle" size={32} />
              </div>
              <p className={styles.stateTitle}>
                {iframeError ? 'Preview failed to load' : 'Build Error'}
              </p>
              <span className={styles.stateSubtitle}>
                {preview.errorMessage ?? 'Check the terminal for details'}
              </span>
              <button className={styles.retryBtn} onClick={handleStart}>
                <Icon name="refresh" size={13} /> Retry
              </button>
            </div>
          )}

          {/* Idle — no server running */}
          {status === 'idle' && !isLoading && (
            <div className={styles.stateScreen}>
              <div className={styles.stateIcon}>
                <Icon name="monitor" size={36} />
              </div>
              <p className={styles.stateTitle}>No preview running</p>
              <span className={styles.stateSubtitle}>
                Start the dev server to see your app update live as files change
              </span>
              <button
                className={styles.startFullBtn}
                onClick={handleStart}
                disabled={!workspaceId}
                title={workspaceId ? undefined : 'No workspace available'}
              >
                <Icon name="play" size={14} />
                Start preview
              </button>
            </div>
          )}

          {/* Stopped */}
          {status === 'stopped' && !isLoading && (
            <div className={styles.stateScreen}>
              <div className={styles.stateIcon}>
                <Icon name="stop" size={32} />
              </div>
              <p className={styles.stateTitle}>Dev server stopped</p>
              <button
                className={styles.startFullBtn}
                onClick={handleStart}
                disabled={!workspaceId}
              >
                <Icon name="play" size={14} />
                Restart preview
              </button>
            </div>
          )}

          {/* Live iframe — mounted as soon as server is ready (or compiling,
              so it stays alive during recompile instead of flashing) */}
          {(status === 'ready' || status === 'compiling') && !hasError && (
            <iframe
              ref={iframeRef}
              key={`preview-${workspaceId}`}     /* stable key — never remount */
              src={iframeSrc}
              className={styles.iframe}
              title="Live Preview"
              onLoad={() => setIframeError(false)}
              onError={() => setIframeError(true)}
              /* Broad sandbox to allow most web apps to run correctly */
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-pointer-lock"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      )}
    </div>
  )
}
