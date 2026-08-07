/**
 * Workspace — v0-style IDE layout: Browser Preview | AI Timeline + Files | Editor + bottom panel.
 * All three panes resizable; preview collapsible. Preview + file tree update live over WS.
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
import { cn } from '@/lib/utils'

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

function healthDotColor(status: string | undefined): string {
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
    const matches = ids.length === expectedIds.length && expectedIds.every((id) => id in parsed)
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

const COLS_KEY = 'workspace_layout_cols_v3'
const ROWS_KEY = 'workspace_layout_rows_v3'
const COLS_IDS = ['preview', 'mid', 'editor']
const ROWS_IDS = ['editor', 'bottom']

const PANE = 'h-full min-h-0 overflow-hidden'
const SEP_V = 'w-px bg-line transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary'
const SEP_H = 'h-px bg-line transition-colors hover:bg-primary/40 data-[resize-handle-state=drag]:bg-primary'
const ICON_BTN = 'flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg'

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

  const [colsLayout] = useState<Layout | undefined>(() => loadLayout(COLS_KEY, COLS_IDS))
  const [rowsLayout] = useState<Layout | undefined>(() => loadLayout(ROWS_KEY, ROWS_IDS))

  useWorkspaceSocket(workspaceId)
  useWorkspaceTabs(workspaceId)

  const { data: treeData, isLoading: treeLoading } = useGetFileTreeQuery(workspaceId, {
    skip: !workspaceId,
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
    if (p.isCollapsed()) { p.expand(); setPreviewCollapsed(false) }
    else { p.collapse(); setPreviewCollapsed(true) }
  }
  const toggleMid = () => {
    const p = midPanel.current
    if (!p) return
    if (p.isCollapsed()) { p.expand(); setMidCollapsed(false) }
    else { p.collapse(); setMidCollapsed(true) }
  }

  const reconnecting = connectionStatus === 'connecting' || connectionStatus === 'disconnected'
  const containerStatus = health?.container.status
  const gitCounts =
    (gitStatus?.modified?.length ?? 0) + (gitStatus?.staged?.length ?? 0) + (gitStatus?.untracked?.length ?? 0)
  const collabActive = collab.status === 'running' || collab.status === 'paused'
  const phaseLive = mission.available ? mission.live : collabActive
  const phaseText = mission.available ? mission.label : collab.label ?? COLLAB_LABEL[collab.status] ?? 'Idle'
  const problemCount = diagnostics.length
  const previewStatus = preview.status
  const previewLive = previewStatus === 'ready' || previewStatus === 'compiling'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      {/* Toolbar */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-2 border-b border-line bg-surface px-2">
        <div className="flex items-center gap-1">
          <button className={ICON_BTN} onClick={togglePreview} title={previewCollapsed ? 'Show preview' : 'Hide preview'} aria-pressed={!previewCollapsed}>
            <Icon name="monitor" size={14} />
          </button>
          <button className={ICON_BTN} onClick={toggleMid} title={midCollapsed ? 'Show timeline' : 'Hide timeline'} aria-pressed={!midCollapsed}>
            <Icon name="sidebar" size={14} />
          </button>
          <button className={ICON_BTN} onClick={() => (taskId ? navigate(`/mission/${taskId}`) : navigate(ROUTES.root))} title="Back to mission">
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="ml-1 flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon name="sparkles" size={14} />
          </span>
          <span className="ml-1 flex items-center gap-1.5 font-mono text-xs">
            <span className="text-fg-muted">{workspaceId.slice(0, 8)}</span>
            <Icon name="chevronRight" size={12} className="text-fg-subtle opacity-50" />
            <span className="flex items-center gap-1 text-fg-subtle">
              <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
            </span>
          </span>
        </div>

        <div className="flex items-center">
          {phaseLive && (
            <div className="flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 font-mono text-[11px] text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {phaseText}
              <span className="h-1 w-16 overflow-hidden rounded-full bg-primary/20">
                <span className="block h-full w-1/2 animate-pulse rounded-full bg-primary" />
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px]">
          {previewLive && (
            <span className="flex items-center gap-1.5 text-fg-subtle" title={`Preview: ${previewStatus}`}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: previewStatus === 'compiling' ? 'var(--warning)' : 'var(--success)' }} />
              {previewStatus === 'compiling' ? 'Compiling' : 'Live Preview'}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-fg-subtle" title={`container: ${containerStatus ?? 'unknown'}`}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: healthDotColor(containerStatus) }} />
            {containerStatus ?? '—'}
          </span>
        </div>
      </div>

      {reconnecting && (
        <div className="flex items-center gap-2 bg-warning/10 px-3 py-1 text-[11px] text-warning">
          <Spinner size={12} /> Reconnecting…
        </div>
      )}

      {/* Body: three resizable columns */}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" id="ws-cols-v3" className="h-full w-full" defaultLayout={colsLayout} onLayoutChanged={(l) => saveLayout(COLS_KEY, l)}>
          {/* Column 1: Browser Preview */}
          <Panel id="preview" className={PANE} panelRef={previewPanel} collapsible collapsedSize={0} minSize="14" defaultSize="28" onResize={(s) => setPreviewCollapsed(s.asPercentage < 1)}>
            <LivePreview workspaceId={workspaceId} collapsed={false} onToggleCollapse={togglePreview} />
          </Panel>

          <Separator className={SEP_V} />

          {/* Column 2: AI Timeline + File Explorer */}
          <Panel id="mid" className={PANE} panelRef={midPanel} collapsible collapsedSize={0} minSize="14" defaultSize="22" onResize={(s) => setMidCollapsed(s.asPercentage < 1)}>
            <Group orientation="vertical" id="ws-mid-rows" className="h-full w-full">
              <Panel id="mid-explorer" className={PANE} minSize="20" defaultSize="45">
                <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-line-subtle bg-surface px-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
                  <Icon name="folder" size={13} /> <span>Files</span>
                  {gitCounts > 0 && (
                    <span className="ml-auto rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{gitCounts}</span>
                  )}
                </div>
                <div ref={explorerBodyRef} className="min-h-0 flex-1 overflow-hidden" style={{ height: 'calc(100% - 60px)' }}>
                  {treeLoading ? (
                    <div className="flex h-full items-center justify-center"><Spinner size={16} /></div>
                  ) : (
                    <FileExplorer workspaceId={workspaceId} height={explorerHeight} decorations={decorations} />
                  )}
                </div>
                <div className="flex h-7 flex-shrink-0 items-center gap-1.5 border-t border-line-subtle px-3 font-mono text-[11px] text-fg-subtle">
                  <Icon name="branch" size={12} /> {gitStatus?.branch ?? '—'}
                  <span className="ml-auto">{gitCounts} changed</span>
                </div>
              </Panel>

              <Separator className={SEP_H} />

              <Panel id="mid-ai" className={PANE} minSize="25" defaultSize="55">
                <AICollabPanel workspaceId={workspaceId} mission={mission} />
              </Panel>
            </Group>
          </Panel>

          <Separator className={SEP_V} />

          {/* Column 3: Editor + bottom dev panel */}
          <Panel id="editor" className={PANE} minSize="30" defaultSize="50">
            <Group orientation="vertical" id="ws-rows-v3" className="h-full w-full" defaultLayout={rowsLayout} onLayoutChanged={(l) => saveLayout(ROWS_KEY, l)}>
              <Panel id="editor" className={PANE} minSize="20" defaultSize="68">
                <CodeEditor workspaceId={workspaceId} />
              </Panel>

              <Separator className={SEP_H} />

              <Panel id="bottom" className={cn(PANE, 'flex flex-col')} minSize="8" defaultSize="32">
                <div className="flex h-8 flex-shrink-0 items-stretch border-b border-line bg-surface">
                  {BOTTOM_TABS.map((t) => (
                    <button
                      key={t.id}
                      className={cn(
                        'flex cursor-pointer items-center gap-1.5 border-r border-line-subtle px-3 text-xs transition-colors',
                        bottomTab === t.id ? 'bg-card text-fg shadow-[inset_0_2px_0_0_var(--color-primary)]' : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-muted',
                      )}
                      onClick={() => setBottomTab(t.id)}
                    >
                      <Icon name={t.icon} size={12} />
                      <span>{t.label}</span>
                      {t.id === 'problems' && problemCount > 0 && (
                        <span className="rounded-full bg-destructive/15 px-1.5 text-[10px] text-destructive">{problemCount}</span>
                      )}
                      {t.id === 'git' && gitCounts > 0 && (
                        <span className="rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{gitCounts}</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <div className="h-full" style={{ display: bottomTab === 'terminal' ? 'block' : 'none' }}>
                    <TerminalPanel workspaceId={workspaceId} active={bottomTab === 'terminal'} />
                  </div>
                  <div className="h-full" style={{ display: bottomTab === 'output' ? 'block' : 'none' }}>
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

      {/* Status bar */}
      <div className="flex h-6 flex-shrink-0 items-center gap-3 border-t border-line bg-surface px-3 font-mono text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: healthDotColor(containerStatus) }} />
          {connectionStatus}
        </span>
        <span className="flex items-center gap-1"><Icon name="branch" size={11} /> {gitStatus?.branch ?? '—'}</span>
        <span>{gitCounts} changes</span>
        {previewLive && (
          <span className="flex items-center gap-1 text-fg-muted">
            <Icon name="monitor" size={11} />
            {previewStatus === 'compiling' ? 'Recompiling…' : 'Preview live'}
          </span>
        )}
        <div className="flex-1" />
        <span>{openFiles.length} open</span>
        <span className={cn('flex items-center gap-1', phaseLive ? 'text-primary' : 'text-fg-subtle')}>
          <Icon name="sparkles" size={11} /> {phaseLive ? 'Forge AI Active' : 'Forge AI Idle'}
        </span>
      </div>
    </div>
  )
}

export default Workspace
