/**
 * FileExplorer — real-time file tree with live change indicators.
 *
 * The tree refreshes automatically from the WS `filesystem` channel:
 *   file_created   → new node appears, flashes green
 *   file_modified  → node gets an "M" badge, glows blue
 *   file_deleted   → node disappears
 *   file_renamed   → tree invalidated, node updates
 *
 * The file-tree data is fetched via RTK Query (WsFiles tag). The WS handler in
 * useWorkspaceSocket invalidates 'WsFiles' on structural events, so the tree
 * refetches automatically — no polling. `recentChanges` adds an optimistic
 * flash on the row that just changed, before the refetch completes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { List, type RowComponentProps } from 'react-window'
import { Icon } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'
import { useLazyGetFileContentQuery } from '@/services/api/workspaceEditorApi'
import { workspaceSocket } from '@/services/workspace/WorkspaceSocket'
import { languageForPath } from './language'
import type { FileNode } from '@/types/workspaceEditor'
import type { WSEnvelope } from '@/types/workspaceEditor'
import { cn } from '@/lib/utils'

export type GitChangeKind = 'staged' | 'modified' | 'untracked'
/** Map of repo-relative path → git change kind, for explorer decorations. */
export type GitDecorations = Map<string, GitChangeKind>

type LiveChangeKind = 'created' | 'modified' | 'deleted'

const DECOR_MARK: Record<GitChangeKind, string> = {
  staged: 'A',
  modified: 'M',
  untracked: 'U',
}
const DECOR_TEXT: Record<GitChangeKind, string> = {
  staged: 'text-success',
  modified: 'text-info',
  untracked: 'text-warning',
}

interface FlatNode {
  node: FileNode
  depth: number
}

/** Depth-first flatten of the visible tree (respecting collapsed dirs). */
function flatten(root: FileNode | null, expanded: Set<string>): FlatNode[] {
  if (!root) return []
  const out: FlatNode[] = []
  const walk = (node: FileNode, depth: number) => {
    if (depth >= 0) out.push({ node, depth })
    if (node.type === 'directory' && expanded.has(node.path) && node.children) {
      for (const child of node.children) walk(child, depth + 1)
    }
  }
  if (root.children) {
    for (const child of root.children) walk(child, 0)
  }
  return out
}

interface RowData {
  rows: FlatNode[]
  expanded: Set<string>
  activePath: string | null
  decorations: GitDecorations
  liveChanges: Map<string, LiveChangeKind>
  onToggle: (path: string) => void
  onOpen: (node: FileNode) => void
}

function Row({
  index,
  style,
  rows,
  expanded,
  activePath,
  decorations,
  liveChanges,
  onToggle,
  onOpen,
}: RowComponentProps<RowData>) {
  const { node, depth } = rows[index]
  const isDir = node.type === 'directory'
  const isOpen = expanded.has(node.path)
  const active = node.path === activePath
  const decor = !isDir ? decorations.get(node.path) : undefined
  const liveChange = liveChanges.get(node.path)

  const liveBg =
    liveChange === 'created' ? 'bg-success/10'
      : liveChange === 'modified' ? 'bg-info/10'
        : liveChange === 'deleted' ? 'bg-destructive/10'
          : ''

  return (
    <div
      style={{ ...style, paddingLeft: depth * 12 + 8 }}
      className={cn(
        'flex cursor-pointer items-center gap-1.5 pr-2 text-[13px] transition-colors duration-300',
        active ? 'bg-primary/10 text-fg' : 'text-fg-muted hover:bg-surface-2',
        liveBg,
      )}
      onClick={() => (isDir ? onToggle(node.path) : onOpen(node))}
      title={node.path}
    >
      {isDir ? (
        <Icon
          name="chevronRight"
          size={12}
          className={cn('flex-shrink-0 text-fg-subtle transition-transform duration-150', isOpen && 'rotate-90')}
        />
      ) : (
        <span className="w-3 flex-shrink-0" />
      )}
      <Icon
        name={isDir ? 'folder' : 'file'}
        size={13}
        className={cn('flex-shrink-0', isDir ? 'text-info/80' : 'text-fg-subtle')}
      />
      <span className={cn('min-w-0 flex-1 truncate font-mono', decor && DECOR_TEXT[decor])}>{node.name}</span>
      {liveChange === 'created' && <span className="flex-shrink-0 font-mono text-[10px] font-bold text-success">N</span>}
      {liveChange === 'modified' && !decor && <span className="flex-shrink-0 text-[10px] text-info">●</span>}
      {decor && !liveChange && (
        <span className={cn('flex-shrink-0 font-mono text-[10px] font-bold', DECOR_TEXT[decor])}>{DECOR_MARK[decor]}</span>
      )}
    </div>
  )
}

/** How long a live-change flash stays visible before fading (ms). */
const LIVE_CHANGE_TTL = 4000

export function FileExplorer({
  workspaceId,
  height,
  decorations = new Map(),
}: {
  workspaceId: string
  height?: number
  decorations?: GitDecorations
}) {
  const dispatch = useAppDispatch()
  const fileTree = useAppSelector((s) => s.workspaceEditor.fileTree)
  const activePath = useAppSelector((s) => s.workspaceEditor.activeFilePath)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [fetchContent] = useLazyGetFileContentQuery()

  // Self-measure available height so the virtual list fills its rail on any screen.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState(height ?? 400)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setMeasured(el.clientHeight || height || 400))
    ro.observe(el)
    setMeasured(el.clientHeight || height || 400)
    return () => ro.disconnect()
  }, [height])

  // ── Live change indicators ─────────────────────────────────────────────
  const [liveChanges, setLiveChanges] = useState<Map<string, LiveChangeKind>>(new Map())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const markChange = useCallback((path: string, kind: LiveChangeKind) => {
    const existing = timersRef.current.get(path)
    if (existing) clearTimeout(existing)

    setLiveChanges((prev) => {
      const next = new Map(prev)
      next.set(path, kind)
      return next
    })

    const t = setTimeout(() => {
      setLiveChanges((prev) => {
        const next = new Map(prev)
        next.delete(path)
        return next
      })
      timersRef.current.delete(path)
    }, LIVE_CHANGE_TTL)

    timersRef.current.set(path, t)
  }, [])

  // Subscribe to the filesystem channel for live change indicators.
  useEffect(() => {
    if (!workspaceId) return

    const unsub = workspaceSocket.subscribe('filesystem', (env: WSEnvelope) => {
      const p = env.payload as Record<string, unknown>
      const path = typeof p.path === 'string' ? p.path : null
      if (!path) return

      switch (env.ev) {
        case 'file_created':
          markChange(path, 'created')
          break
        case 'file_modified':
          markChange(path, 'modified')
          break
        case 'file_deleted':
          markChange(path, 'deleted')
          setTimeout(() => {
            setLiveChanges((prev) => {
              const next = new Map(prev)
              next.delete(path)
              return next
            })
          }, 800)
          break
        case 'file_renamed': {
          const oldPath = typeof p.old_path === 'string' ? p.old_path : null
          if (oldPath) markChange(oldPath, 'deleted')
          markChange(path, 'created')
          break
        }
      }
    })

    return () => {
      unsub()
      timersRef.current.forEach(clearTimeout)
      timersRef.current.clear()
    }
  }, [workspaceId, markChange])

  // ── Tree interaction ───────────────────────────────────────────────────
  const rows = useMemo(() => flatten(fileTree, expanded), [fileTree, expanded])

  const onToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const onOpen = useCallback(
    async (node: FileNode) => {
      dispatch(setActiveFile(node.path))
      try {
        const res = await fetchContent({ workspaceId, path: node.path }).unwrap()
        dispatch(
          openFile({
            path: node.path,
            content: res.content ?? '',
            language: res.language ?? languageForPath(node.path),
            dirty: false,
          }),
        )
      } catch {
        // Non-fatal — tab won't open if content can't be fetched.
      }
    },
    [workspaceId, dispatch, fetchContent],
  )

  return (
    <div ref={wrapRef} className="h-full w-full overflow-hidden py-1">
      {!fileTree || rows.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          <Icon name="folder" size={20} className="text-fg-subtle opacity-50" />
          <span className="max-w-[160px] text-[11px] leading-relaxed text-fg-subtle">
            {!workspaceId ? 'No workspace yet' : 'No files found in workspace'}
          </span>
        </div>
      ) : (
        <List
          rowCount={rows.length}
          rowHeight={24}
          rowComponent={Row}
          rowProps={{ rows, expanded, activePath, decorations, liveChanges, onToggle, onOpen }}
          style={{ height: measured, width: '100%' }}
        />
      )}
    </div>
  )
}
