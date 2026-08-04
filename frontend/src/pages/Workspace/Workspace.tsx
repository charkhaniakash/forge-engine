/**
 * Workspace — v0-style IDE layout
 *
 * ┌──────────────────┬─────────────────┬──────────────────────┐
 * │  Browser Preview │  AI Timeline    │  Monaco Editor       │
 * │  (collapsible)   │  + File Tree    │  + Bottom panel      │
 * │                  │  + AI Activity  │  (terminal/output/…) │
 * └──────────────────┴─────────────────┴──────────────────────┘
 *
 * All three panes are resizable. The preview pane is collapsible.
 * The preview updates automatically when any file changes (WS `preview` channel).
 * The file tree refreshes in real-time (WS `filesystem` channel).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels'
import { Icon, Spinner } from '@/components/common'
import type { IconName } from '@/components/common'
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
import { OutputPanel } from '@/features/workspace/OutputPanel'
import { GitPanel } from '@/features/workspace/GitPanel'
import { DiagnosticsPanel } from '@/features/workspace/DiagnosticsPanel'
import { AICollabPanel } from '@/features/workspace/AICollabPanel'
import { LivePreview } from '@/features/workspace/LivePreview'
import { useMissionPhase } from '@/features/workspace/useMissionPhase'
import { ROUTES } from '@/constants/routes'
import styles from './Workspace.module.css'

type BottomTab = 'terminal' | 'output' | 'problems' | 'git' | 'timeline'

const BOTTOM_TABS: Array<{ id: BottomTab; label: string; icon: IconName }> = [
  { id: 'terminal', label: 'Terminal', icon: 'tool' },
  { id: 'output', label: 'Output', icon: 'execution' },
  { id: 'problems', label: 'Problems', icon: 'alert' },
  { id: 'git', label: 'Git', icon: 'branch' },
  { id: 'timeline', label: 'Timeline', icon: 'clock' },
]

const COLLAB_LABEL: Record<string, string> = {
  running: 'AI is working',
  paused: 'AI paused',
  stopped: 'AI stopped',
  completed: 'AI finished',
  idle: 'Idle',
}

function healthColor(status: string | undefined): string {
  if (status === 'running' || status === 'ready' || status === 'executing') return 'var(--success)'
  if (status === 'provisioning') return 'var(--warning)'
  return 'var(--danger)'
}

function loadLayout(key: string, expectedIds: string[]): Layout | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Layout
    const ids = Object.keys(parsed)
    const matches =
      ids.length === expectedIds.length && expectedIds.every((id) => id in parsed)
    if (!matches) {
      localStorage.removeItem(key)
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function saveLayout(key: string, layout: Layout): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout))
  } catch { /* ignore */ }
}

// Layout persistence keys — v3 because column IDs changed
const COLS_KEY = 'workspace_layout_cols_v3'
const ROWS_KEY = 'workspace_layout_rows_v3'
const COLS_IDS = ['preview', 'mid', 'editor']
const ROWS_IDS = ['editor', 'bottom']

export function Workspace() {
  const { workspaceId = '' } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const mission = useMissionPhase(repoId, taskId ?? '')

  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal')
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
  const [midCollapsed, setMidCollapsed] = useState(false)
  const previewPanel = usePanelRef()
  const midPanel = usePanelRef()
  const explorerBodyRef = useRef<HTMLDivElement>(null)
  const [explorerHeight, setExplorerHeight] = useState(200)

  // Persisted layouts
  const [colsLayout] = useState<Layout | undefined>(() => loadLayout(COLS_KEY, COLS_IDS))
  const [rowsLayout] = useState<Layout | undefined>(() => loadLayout(ROWS_KEY, ROWS_IDS))

  useWorkspaceSocket(workspaceId)
  useWorkspaceTabs(workspaceId)

  const { data: treeData, isLoading: treeLoading } = useGetFileTreeQuery(workspaceId, {
    skip: !workspaceId,
    // The WS `filesystem` channel invalidates 'WsFiles' so this auto-refetches
    // on file_created / file_deleted / file_renamed events.
    refetchOnMountOrArgChange: true,
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
  const collab = useAppSelector((s) => s.workspaceActivity.collaboration)
  const diagnostics = useAppSelector((s) => s.workspaceActivity.diagnostics)
  const preview = useAppSelector((s) => s.workspaceActivity.preview)

  const decorations = useMemo<GitDecorations>(() => {
    const m = new Map<string, 'staged' | 'modified' | 'untracked'>()
    gitStatus?.untracked?.forEach((p) => m.set(p, 'untracked'))
    gitStatus?.modified?.forEach((p) => m.set(p, 'modified'))
    gitStatus?.staged?.forEach((p) => m.set(p, 'staged'))
    return m
  }, [gitStatus])

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

  const togglePreview = () => {
    const p = previewPanel.current
    if (!p) return
    if (p.isCollapsed()) {
      p.expand()
      setPreviewCollapsed(false)
    } else {
      p.collapse()
      setPreviewCollapsed(true)
    }
  }

  const toggleMid = () => {
    const p = midPanel.current
    if (!p) return
    if (p.isCollapsed()) {
      p.expand()
      setMidCollapsed(false)
    } else {
      p.collapse()
      setMidCollapsed(true)
    }
  }

  const reconnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected'
  const containerStatus = health?.container.status
  const gitCounts =
    (gitStatus?.modified?.length ?? 0) +
    (gitStatus?.staged?.length ?? 0) +
    (gitStatus?.untracked?.length ?? 0)
  const collabActive = collab.status === 'running' || collab.status === 'paused'
  const phaseLive = mission.available ? mission.live : collabActive
  const phaseText = mission.available
    ? mission.label
    : collab.label ?? COLLAB_LABEL[collab.status] ?? 'Idle'
  const problemCount = diagnostics.length

  // Preview status badge
  const previewStatus = preview.status
  const previewLive = previewStatus === 'ready' || previewStatus === 'compiling'

  return (
    <div className={styles.root}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button
            className={styles.iconBtn}
            onClick={togglePreview}
            title={previewCollapsed ? 'Show preview' : 'Hide preview'}
            aria-pressed={!previewCollapsed}
          >
            <Icon name="monitor" size={14} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={toggleMid}
            title={midCollapsed ? 'Show timeline' : 'Hide timeline'}
            aria-pressed={!midCollapsed}
          >
            <Icon name="sidebar" size={14} />
          </button>
          <button
            className={styles.back}
            onClick={() => (taskId ? navigate(`/mission/${taskId}`) : navigate(ROUTES.root))}
            title="Back to mission"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className={styles.brandMark}>
            <Icon name="sparkles" size={14} />
          </span>
          <span className={styles.crumb}>
            <span className={styles.crumbRepo}>{workspaceId.slice(0, 8)}</span>
            <Icon name="chevronRight" size={12} className={styles.crumbSep} />
            <span className={styles.crumbBranch}>
              <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
            </span>
          </span>
        </div>

        <div className={styles.toolbarCenter}>
          {phaseLive && (
            <div className={styles.aiStatus}>
              <span className={styles.aiPulse} />
              {phaseText}
              <span className={styles.aiTrack}>
                <span className={styles.aiBar} />
              </span>
            </div>
          )}
        </div>

        <div className={styles.toolbarRight}>
          {/* Preview status */}
          {previewLive && (
            <span className={styles.previewBadge} title={`Preview: ${previewStatus}`}>
              <span className={styles.previewDot}
                style={{ background: previewStatus === 'compiling' ? 'var(--warning)' : 'var(--success)' }} />
              {previewStatus === 'compiling' ? 'Compiling' : 'Live Preview'}
            </span>
          )}
          <span className={styles.health} title={`container: ${containerStatus ?? 'unknown'}`}>
            <span className={styles.healthDot} style={{ background: healthColor(containerStatus) }} />
            {containerStatus ?? '—'}
          </span>
        </div>
      </div>

      {reconnecting && (
        <div className={styles.reconnecting}>
          <Spinner size={12} /> Reconnecting…
        </div>
      )}

      {/* ── Body: three resizable columns ───────────────────────────────── */}
      <div className={styles.body}>
        <Group
          orientation="horizontal"
          id="ws-cols-v3"
          className={styles.group}
          defaultLayout={colsLayout}
          onLayoutChanged={(l) => saveLayout(COLS_KEY, l)}
        >
          {/* ── Column 1: Browser Preview ─────────────────────────────── */}
          <Panel
            id="preview"
            className={styles.pane}
            panelRef={previewPanel}
            collapsible
            collapsedSize={0}
            minSize="14"
            defaultSize="28"
            onResize={(s) => setPreviewCollapsed(s.asPercentage < 1)}
          >
            <LivePreview
              workspaceId={workspaceId}
              collapsed={false}
              onToggleCollapse={togglePreview}
            />
          </Panel>

          <Separator className={styles.sepV} />

          {/* ── Column 2: AI Timeline + File Explorer ─────────────────── */}
          <Panel
            id="mid"
            className={styles.pane}
            panelRef={midPanel}
            collapsible
            collapsedSize={0}
            minSize="14"
            defaultSize="22"
            onResize={(s) => setMidCollapsed(s.asPercentage < 1)}
          >
            {/* Mid column: file tree top, AI collab bottom */}
            <Group orientation="vertical" id="ws-mid-rows" className={styles.group}>
              {/* File explorer */}
              <Panel id="mid-explorer" className={styles.pane} minSize="20" defaultSize="45">
                <div className={styles.paneHeader}>
                  <Icon name="folder" size={13} /> <span>Files</span>
                  {gitCounts > 0 && (
                    <span className={styles.tabBadge} style={{ marginLeft: 'auto' }}>{gitCounts}</span>
                  )}
                </div>
                <div ref={explorerBodyRef} className={styles.explorerBody}>
                  {treeLoading ? (
                    <div className={styles.centerFill}><Spinner size={16} /></div>
                  ) : (
                    <FileExplorer
                      workspaceId={workspaceId}
                      height={explorerHeight}
                      decorations={decorations}
                    />
                  )}
                </div>
                <div className={styles.gitMini}>
                  <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
                  <span className={styles.gitMiniCount}>{gitCounts} changed</span>
                </div>
              </Panel>

              <Separator className={styles.sepH} />

              {/* AI Collaboration + controls */}
              <Panel id="mid-ai" className={styles.pane} minSize="25" defaultSize="55">
                <AICollabPanel workspaceId={workspaceId} mission={mission} />
              </Panel>
            </Group>
          </Panel>

          <Separator className={styles.sepV} />

          {/* ── Column 3: Monaco editor + bottom dev panel ──────────────── */}
          <Panel id="editor" className={styles.pane} minSize="30" defaultSize="50">
            <Group
              orientation="vertical"
              id="ws-rows-v3"
              className={styles.group}
              defaultLayout={rowsLayout}
              onLayoutChanged={(l) => saveLayout(ROWS_KEY, l)}
            >
              <Panel id="editor" className={styles.pane} minSize="20" defaultSize="68">
                <CodeEditor workspaceId={workspaceId} />
              </Panel>

              <Separator className={styles.sepH} />

              <Panel id="bottom" className={styles.pane} minSize="8" defaultSize="32">
                <div className={styles.bottomTabs}>
                  {BOTTOM_TABS.map((t) => (
                    <button
                      key={t.id}
                      className={`${styles.bottomTab} ${bottomTab === t.id ? styles.bottomTabActive : ''}`}
                      onClick={() => setBottomTab(t.id)}
                    >
                      <Icon name={t.icon} size={12} />
                      <span>{t.label}</span>
                      {t.id === 'problems' && problemCount > 0 && (
                        <span className={styles.tabBadge}>{problemCount}</span>
                      )}
                      {t.id === 'git' && gitCounts > 0 && (
                        <span className={styles.tabBadge}>{gitCounts}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className={styles.bottomBody}>
                  <div className={styles.mount}
                    style={{ display: bottomTab === 'terminal' ? 'block' : 'none' }}>
                    <TerminalPanel workspaceId={workspaceId} active={bottomTab === 'terminal'} />
                  </div>
                  <div className={styles.mount}
                    style={{ display: bottomTab === 'output' ? 'block' : 'none' }}>
                    <OutputPanel active={bottomTab === 'output'} />
                  </div>
                  {bottomTab === 'problems' && <DiagnosticsPanel workspaceId={workspaceId} />}
                  {bottomTab === 'git' && <GitPanel workspaceId={workspaceId} />}
                  {bottomTab === 'timeline' && <TimelinePanel />}
                </div>
              </Panel>
            </Group>
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
        {previewLive && (
          <span className={styles.previewStatusBar}>
            <Icon name="monitor" size={11} />
            {previewStatus === 'compiling' ? 'Recompiling…' : 'Preview live'}
          </span>
        )}
        <div className={styles.toolbarSpacer} />
        <span>{openFiles.length} open</span>
        <span className={`${styles.forgeAi} ${phaseLive ? styles.forgeAiActive : ''}`}>
          <Icon name="sparkles" size={11} /> {phaseLive ? 'Forge AI Active' : 'Forge AI Idle'}
        </span>
      </div>
    </div>
  )
}

export default Workspace
