import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels'
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
import { FileExplorer, type GitDecorations } from '@/features/workspace/FileExplorer'
import { CodeEditor } from '@/features/workspace/CodeEditor'
import { TerminalPanel } from '@/features/workspace/TerminalPanel'
import { TimelinePanel } from '@/features/workspace/TimelinePanel'
import { AIActivityFeed } from '@/features/workspace/AIActivityFeed'
import { OutputPanel } from '@/features/workspace/OutputPanel'
import { GitPanel } from '@/features/workspace/GitPanel'
import { DiagnosticsPanel } from '@/features/workspace/DiagnosticsPanel'
import { CollaborationBar } from '@/features/workspace/CollaborationBar'
import { ROUTES } from '@/constants/routes'
import styles from './Workspace.module.css'

type SidebarTab = 'timeline' | 'ai' | 'output' | 'git' | 'diagnostics'

const SIDEBAR_TABS: Array<{ id: SidebarTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'output', label: 'Output', icon: 'tool' },
  { id: 'timeline', label: 'Timeline', icon: 'clock' },
  { id: 'ai', label: 'AI', icon: 'chat' },
  { id: 'diagnostics', label: 'Problems', icon: 'alert' },
  { id: 'git', label: 'Git', icon: 'branch' },
]

function healthColor(status: string | undefined): string {
  if (status === 'running' || status === 'ready' || status === 'executing') return 'var(--success)'
  if (status === 'provisioning') return 'var(--warning)'
  return 'var(--danger)'
}

function loadLayout(key: string): Layout | undefined {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Layout) : undefined
  } catch {
    return undefined
  }
}

function saveLayout(key: string, layout: Layout): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout))
  } catch {
    // ignore quota / unavailability
  }
}

const COLS_KEY = 'workspace_layout_cols'
const ROWS_KEY = 'workspace_layout_rows'

export function Workspace() {
  const { workspaceId = '' } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('output')
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const explorerPanel = usePanelRef()

  // Persisted pane layouts.
  const [colsLayout] = useState<Layout | undefined>(() => loadLayout(COLS_KEY))
  const [rowsLayout] = useState<Layout | undefined>(() => loadLayout(ROWS_KEY))

  // Single multiplexed socket for the whole IDE + tab session recovery.
  useWorkspaceSocket(workspaceId)
  useWorkspaceTabs(workspaceId)

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

  // Git decorations for the explorer (path → change kind).
  const decorations = useMemo<GitDecorations>(() => {
    const m = new Map<string, 'staged' | 'modified' | 'untracked'>()
    gitStatus?.untracked?.forEach((p) => m.set(p, 'untracked'))
    gitStatus?.modified?.forEach((p) => m.set(p, 'modified'))
    gitStatus?.staged?.forEach((p) => m.set(p, 'staged'))
    return m
  }, [gitStatus])

  // Measure the explorer body so react-window gets a concrete height.
  const explorerBodyRef = useRef<HTMLDivElement>(null)
  const [explorerHeight, setExplorerHeight] = useState(300)
  useLayoutEffect(() => {
    const el = explorerBodyRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height
      if (h) setExplorerHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggleExplorer = () => {
    const p = explorerPanel.current
    if (!p) return
    if (p.isCollapsed()) {
      p.expand()
      setExplorerCollapsed(false)
    } else {
      p.collapse()
      setExplorerCollapsed(true)
    }
  }

  const reconnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected'
  const containerStatus = health?.container.status
  const gitCounts =
    (gitStatus?.modified?.length ?? 0) +
    (gitStatus?.staged?.length ?? 0) +
    (gitStatus?.untracked?.length ?? 0)

  return (
    <div className={styles.root}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <button className={styles.iconBtn} onClick={toggleExplorer} title="Toggle Explorer" aria-pressed={!explorerCollapsed}>
          <Icon name="sidebar" size={15} />
        </button>
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

      {/* ── Body: resizable panes ───────────────────────────────────────── */}
      <div className={styles.body}>
        <Group
          orientation="horizontal"
          id="ws-cols"
          className={styles.group}
          defaultLayout={colsLayout}
          onLayoutChanged={(l) => saveLayout(COLS_KEY, l)}
        >
          {/* Explorer (collapsible) */}
          <Panel
            id="explorer"
            className={styles.pane}
            panelRef={explorerPanel}
            collapsible
            collapsedSize={0}
            minSize="12"
            defaultSize="18"
            onResize={(s) => setExplorerCollapsed(s.asPercentage < 1)}
          >
            <div className={styles.paneHeader}>
              <span>Explorer</span>
            </div>
            <div ref={explorerBodyRef} className={styles.explorerBody}>
              {treeLoading ? (
                <div className={styles.centerFill}><Spinner size={16} /></div>
              ) : (
                <FileExplorer workspaceId={workspaceId} height={explorerHeight} decorations={decorations} />
              )}
            </div>
            <div className={styles.gitMini}>
              <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
              <span className={styles.gitMiniCount}>{gitCounts} changed</span>
            </div>
          </Panel>

          <Separator className={styles.sepV} />

          {/* Center: editor over terminal */}
          <Panel id="center" className={styles.pane} minSize="30">
            <Group
              orientation="vertical"
              id="ws-rows"
              className={styles.group}
              defaultLayout={rowsLayout}
              onLayoutChanged={(l) => saveLayout(ROWS_KEY, l)}
            >
              <Panel id="editor" className={styles.pane} minSize="20" defaultSize="70">
                <CodeEditor workspaceId={workspaceId} />
              </Panel>

              <Separator className={styles.sepH} />

              <Panel id="terminal" className={styles.pane} minSize="8" defaultSize="30">
                <div className={styles.paneHeader}>
                  <Icon name="tool" size={12} /> <span>Terminal</span>
                </div>
                <div className={styles.terminalBody}>
                  <TerminalPanel workspaceId={workspaceId} active />
                </div>
              </Panel>
            </Group>
          </Panel>

          <Separator className={styles.sepV} />

          {/* Right sidebar: Timeline / AI / Problems / Git */}
          <Panel id="sidebar" className={styles.pane} minSize="14" defaultSize="22">
            <div className={styles.sidebarTabs}>
              {SIDEBAR_TABS.map((t) => (
                <button
                  key={t.id}
                  className={`${styles.sidebarTab} ${sidebarTab === t.id ? styles.sidebarTabActive : ''}`}
                  onClick={() => setSidebarTab(t.id)}
                  title={t.label}
                >
                  <Icon name={t.icon} size={13} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <div className={styles.sidebarBody}>
              {/* Output stays mounted so xterm keeps its buffer across tab switches. */}
              <div style={{ display: sidebarTab === 'output' ? 'block' : 'none', height: '100%' }}>
                <OutputPanel active={sidebarTab === 'output'} />
              </div>
              {sidebarTab === 'timeline' && <TimelinePanel />}
              {sidebarTab === 'ai' && <AIActivityFeed />}
              {sidebarTab === 'diagnostics' && <DiagnosticsPanel workspaceId={workspaceId} />}
              {sidebarTab === 'git' && <GitPanel workspaceId={workspaceId} />}
            </div>
          </Panel>
        </Group>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────── */}
      <div className={styles.statusBar}>
        <span className={styles.statusConn} data-status={connectionStatus}>
          <span className={styles.statusDot} style={{ background: healthColor(containerStatus) }} />
          {connectionStatus}
        </span>
        <span><Icon name="branch" size={11} /> {gitStatus?.branch ?? '—'}</span>
        <span>{gitCounts} changes</span>
        <div className={styles.toolbarSpacer} />
        <span>{openFiles.length} open</span>
      </div>
    </div>
  )
}

export default Workspace
