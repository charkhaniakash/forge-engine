import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon, Spinner } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { useWorkspaceSocket } from '@/hooks/useWorkspaceSocket'
import { useWorkspaceTabs } from '@/hooks/useWorkspaceTabs'
import {
  useGetFileTreeQuery,
  useGetGitStatusQuery,
  useGetWorkspaceHealthQuery,
} from '@/services/api/workspaceEditorApi'
import { setFileTree, setHealth } from '@/store/slices/workspaceEditorSlice'
import { FileExplorer } from '@/features/workspace/FileExplorer'
import { CodeEditor } from '@/features/workspace/CodeEditor'
import { TerminalPanel } from '@/features/workspace/TerminalPanel'
import { TimelinePanel } from '@/features/workspace/TimelinePanel'
import { AIActivityFeed } from '@/features/workspace/AIActivityFeed'
import { GitPanel } from '@/features/workspace/GitPanel'
import { DiagnosticsPanel } from '@/features/workspace/DiagnosticsPanel'
import { CollaborationBar } from '@/features/workspace/CollaborationBar'
import { ROUTES } from '@/constants/routes'
import styles from './Workspace.module.css'

type RightTab = 'timeline' | 'ai' | 'terminal' | 'diagnostics' | 'git'

const RIGHT_TABS: Array<{ id: RightTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'timeline', label: 'Timeline', icon: 'clock' },
  { id: 'ai', label: 'AI Activity', icon: 'chat' },
  { id: 'terminal', label: 'Terminal', icon: 'tool' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'alert' },
  { id: 'git', label: 'Git', icon: 'branch' },
]

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function readWidth(key: string, fallback: number): number {
  const raw = localStorage.getItem(key)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : fallback
}

function writeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // ignore
  }
}

function healthColor(status: string | undefined): string {
  if (status === 'running' || status === 'ready' || status === 'executing') return 'var(--success)'
  if (status === 'provisioning') return 'var(--warning)'
  return 'var(--danger)'
}

export function Workspace() {
  const { workspaceId = '' } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const [rightTab, setRightTab] = useState<RightTab>('timeline')

  // Single multiplexed socket for the whole IDE + tab session recovery.
  useWorkspaceSocket(workspaceId)
  useWorkspaceTabs(workspaceId)

  // Resizable side panels (persisted).
  const [leftWidth, setLeftWidth] = useState(() => readWidth('workspace_left_w', 250))
  const [rightWidth, setRightWidth] = useState(() => readWidth('workspace_right_w', 350))

  const startDrag = (side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startLeft = leftWidth
    const startRight = rightWidth
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (side === 'left') setLeftWidth(clamp(startLeft + dx, 180, 480))
      else setRightWidth(clamp(startRight - dx, 260, 620))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    writeWidth('workspace_left_w', leftWidth)
  }, [leftWidth])
  useEffect(() => {
    writeWidth('workspace_right_w', rightWidth)
  }, [rightWidth])

  const { data: treeData, isLoading: treeLoading } = useGetFileTreeQuery(workspaceId, {
    skip: !workspaceId,
  })
  const { data: health } = useGetWorkspaceHealthQuery(workspaceId, {
    skip: !workspaceId,
    pollingInterval: 10000,
  })
  const { data: gitStatus } = useGetGitStatusQuery(workspaceId, { skip: !workspaceId })

  useEffect(() => {
    if (treeData?.tree) dispatch(setFileTree(treeData.tree))
  }, [treeData, dispatch])
  useEffect(() => {
    if (health) dispatch(setHealth(health))
  }, [health, dispatch])

  const connectionStatus = useAppSelector((s) => s.workspaceEditor.connectionStatus)
  const openFiles = useAppSelector((s) => s.workspaceEditor.openFiles)

  // Measure the explorer area so react-window gets a concrete height.
  const explorerRef = useRef<HTMLDivElement>(null)
  const [explorerHeight, setExplorerHeight] = useState(300)
  useLayoutEffect(() => {
    const el = explorerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h) setExplorerHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const reconnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected'
  const containerStatus = health?.container.status
  const gitCounts =
    (gitStatus?.modified?.length ?? 0) +
    (gitStatus?.staged?.length ?? 0) +
    (gitStatus?.untracked?.length ?? 0)

  return (
    <div className={styles.root}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <button className={styles.back} onClick={() => (taskId ? navigate(`/mission/${taskId}`) : navigate(ROUTES.root))}>
          <Icon name="chevronLeft" size={14} /> Back
        </button>
        <span className={styles.wsName}>
          <Icon name="workspace" size={14} /> Workspace
          <code className={styles.wsId}>{workspaceId.slice(0, 8)}</code>
        </span>
        <span className={styles.health} title={`container: ${containerStatus ?? 'unknown'}`}>
          <span className={styles.healthDot} style={{ background: healthColor(containerStatus) }} />
          {containerStatus ?? '—'}
        </span>
        <div className={styles.toolbarSpacer} />
        <CollaborationBar workspaceId={workspaceId} />
      </div>

      {reconnecting && (
        <div className={styles.reconnecting}>
          <Spinner size={12} /> Reconnecting…
        </div>
      )}

      {/* Body */}
      <div className={styles.body}>
        {/* Left */}
        <aside className={styles.left} style={{ width: leftWidth }}>
          <div className={styles.sectionHeader}>Explorer</div>
          <div ref={explorerRef} className={styles.explorer}>
            {treeLoading ? (
              <div className={styles.center}><Spinner size={16} /></div>
            ) : (
              <FileExplorer workspaceId={workspaceId} height={explorerHeight} />
            )}
          </div>
          <div className={styles.gitMini}>
            <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
            <span className={styles.gitMiniCount}>{gitCounts} changed</span>
          </div>
        </aside>

        <div
          className={styles.resizer}
          onMouseDown={startDrag('left')}
          role="separator"
          aria-orientation="vertical"
        />

        {/* Center */}
        <main className={styles.center}>
          <CodeEditor workspaceId={workspaceId} />
        </main>

        <div
          className={styles.resizer}
          onMouseDown={startDrag('right')}
          role="separator"
          aria-orientation="vertical"
        />

        {/* Right */}
        <aside className={styles.right} style={{ width: rightWidth }}>
          <div className={styles.rightTabs}>
            {RIGHT_TABS.map((t) => (
              <button
                key={t.id}
                className={`${styles.rightTab} ${rightTab === t.id ? styles.rightTabActive : ''}`}
                onClick={() => setRightTab(t.id)}
                title={t.label}
              >
                <Icon name={t.icon} size={13} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <div className={styles.rightBody}>
            {/* Terminal stays mounted so its session + xterm survive tab switches. */}
            <div style={{ display: rightTab === 'terminal' ? 'block' : 'none', height: '100%' }}>
              <TerminalPanel workspaceId={workspaceId} active={rightTab === 'terminal'} />
            </div>
            {rightTab === 'timeline' && <TimelinePanel />}
            {rightTab === 'ai' && <AIActivityFeed />}
            {rightTab === 'diagnostics' && <DiagnosticsPanel workspaceId={workspaceId} />}
            {rightTab === 'git' && <GitPanel workspaceId={workspaceId} />}
          </div>
        </aside>
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <span><Icon name="branch" size={11} /> {gitStatus?.branch ?? '—'}</span>
        <span className={styles.statusConn} data-status={connectionStatus}>
          {connectionStatus === 'connected' ? '● connected' : `● ${connectionStatus}`}
        </span>
        <span>{openFiles.length} open</span>
      </div>
    </div>
  )
}

export default Workspace
