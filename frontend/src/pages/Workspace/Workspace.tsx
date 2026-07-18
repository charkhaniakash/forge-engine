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

/**
 * Load a persisted layout, but only apply it when its panel ids exactly match
 * the panels currently rendered. `react-resizable-panels` keys layouts by panel
 * id ({ [id]: flexGrow }); feeding it a layout for a different set of ids (e.g.
 * after the panels are renamed) makes it thrash and can blank the page. When the
 * ids don't line up we drop the stale entry and fall back to panel defaultSize.
 */
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
  } catch {
    // ignore quota / unavailability
  }
}

const COLS_KEY = 'workspace_layout_cols_v2'
const ROWS_KEY = 'workspace_layout_rows_v2'
const COLS_IDS = ['explorer', 'center', 'ai']
const ROWS_IDS = ['editor', 'bottom']

export function Workspace() {
  const { workspaceId = '' } = useParams()
  const [params] = useSearchParams()
  const taskId = params.get('task')
  const repoId = params.get('repo') ?? ''
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  // Mirror the mission's real phase (task + execution + validation) so the IDE
  // never contradicts the mission page. Falls back gracefully without repo ctx.
  const mission = useMissionPhase(repoId, taskId ?? '')

  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal')
  const [explorerCollapsed, setExplorerCollapsed] = useState(false)
  const explorerPanel = usePanelRef()

  // Persisted pane layouts.
  const [colsLayout] = useState<Layout | undefined>(() => loadLayout(COLS_KEY, COLS_IDS))
  const [rowsLayout] = useState<Layout | undefined>(() => loadLayout(ROWS_KEY, ROWS_IDS))

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
  const collab = useAppSelector((s) => s.workspaceActivity.collaboration)
  const diagnostics = useAppSelector((s) => s.workspaceActivity.diagnostics)

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
  const collabActive = collab.status === 'running' || collab.status === 'paused'
  // Prefer the mission phase for the header/status chrome; fall back to the
  // agent collaboration status when we don't have repo context.
  const phaseLive = mission.available ? mission.live : collabActive
  const phaseText = mission.available
    ? mission.label
    : collab.label ?? COLLAB_LABEL[collab.status] ?? 'Idle'
  const problemCount = diagnostics.length

  return (
    <div className={styles.root}>
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button className={styles.iconBtn} onClick={toggleExplorer} title="Toggle Explorer" aria-pressed={!explorerCollapsed}>
            <Icon name="sidebar" size={15} />
          </button>
          <button className={styles.back} onClick={() => (taskId ? navigate(`/mission/${taskId}`) : navigate(ROUTES.root))} title="Back to mission">
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
              <Icon name="folder" size={13} /> <span>Explorer</span>
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

          {/* Center: editor over bottom dev panel */}
          <Panel id="center" className={styles.pane} minSize="30">
            <Group
              orientation="vertical"
              id="ws-rows"
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
                  {/* Terminal + Output stay mounted so xterm keeps its buffer. */}
                  <div className={styles.mount} style={{ display: bottomTab === 'terminal' ? 'block' : 'none' }}>
                    <TerminalPanel workspaceId={workspaceId} active={bottomTab === 'terminal'} />
                  </div>
                  <div className={styles.mount} style={{ display: bottomTab === 'output' ? 'block' : 'none' }}>
                    <OutputPanel active={bottomTab === 'output'} />
                  </div>
                  {bottomTab === 'problems' && <DiagnosticsPanel workspaceId={workspaceId} />}
                  {bottomTab === 'git' && <GitPanel workspaceId={workspaceId} />}
                  {bottomTab === 'timeline' && <TimelinePanel />}
                </div>
              </Panel>
            </Group>
          </Panel>

          <Separator className={styles.sepV} />

          {/* Right: AI Collaboration */}
          <Panel id="ai" className={styles.pane} minSize="16" defaultSize="24">
            <AICollabPanel workspaceId={workspaceId} mission={mission} />
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
        <span className={`${styles.forgeAi} ${phaseLive ? styles.forgeAiActive : ''}`}>
          <Icon name="sparkles" size={11} /> {phaseLive ? 'Forge AI Active' : 'Forge AI Idle'}
        </span>
      </div>
    </div>
  )
}

export default Workspace
