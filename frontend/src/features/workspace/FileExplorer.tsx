/**
 * FileExplorer — real-time file tree with live change indicators.
 *
 * The tree refreshes automatically from the WS `filesystem` channel:
 *   file_created   → new node appears, flashes green
 *   file_modified  → node gets an "M" badge, glows blue
 *   file_deleted   → node disappears
 *   file_renamed   → tree invalidated, node updates
 *
 * The file-tree data is fetched via RTK Query (WsFiles tag).
 * The WS handler in useWorkspaceSocket invalidates 'WsFiles' on structural
 * events, so the tree refetches automatically — no polling needed.
 *
 * Additionally we track a local `recentChanges` map keyed by path so we can
 * show a flash animation on the row that just changed, even before the RTK
 * refetch completes (optimistic visual feedback).
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
import styles from './workspace.module.css'

export type GitChangeKind = 'staged' | 'modified' | 'untracked'
/** Map of repo-relative path → git change kind, for explorer decorations. */
export type GitDecorations = Map<string, GitChangeKind>

type LiveChangeKind = 'created' | 'modified' | 'deleted'

const DECOR_MARK: Record<GitChangeKind, string> = {
  staged: 'A',
  modified: 'M',
  untracked: 'U',
}
const DECOR_CLASS: Record<GitChangeKind, string> = {
  staged: styles.decorStaged,
  modified: styles.decorModified,
  untracked: styles.decorUntracked,
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
  const decorCls = decor ? DECOR_CLASS[decor] : ''
  const liveChange = liveChanges.get(node.path)

  // Live change class drives the CSS flash animation
  const liveClass = liveChange === 'created'
    ? styles.fileLiveCreated
    : liveChange === 'modified'
      ? styles.fileLiveModified
      : liveChange === 'deleted'
        ? styles.fileLiveDeleted
        : ''

  return (
    <div
      style={{
        ...style,
        paddingLeft: `calc(${depth} * var(--space-4) + var(--space-2))`,
      }}
      className={`${styles.treeRow} ${active ? styles.treeRowActive : ''} ${decor ? styles.fileModified : ''} ${liveClass}`}
      onClick={() => (isDir ? onToggle(node.path) : onOpen(node))}
      title={node.path}
    >
      {isDir ? (
        <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
          <Icon name="chevronRight" size={12} />
        </span>
      ) : (
        <span className={styles.spacer} style={{ width: 12 }} />
      )}
      <Icon name={isDir ? 'repo' : 'file'} size={13} />
      <span className={`${styles.treeName} ${decorCls}`}>{node.name}</span>
      {/* Live change badge (takes priority over git badge when both present) */}
      {liveChange === 'created' && (
        <span className={`${styles.decorMark} ${styles.decorUntracked}`}>N</span>
      )}
      {liveChange === 'modified' && !decor && (
        <span className={`${styles.decorMark} ${styles.decorModified}`}>●</span>
      )}
      {/* Git decoration (shown when no live change overrides it) */}
      {decor && !liveChange && (
        <span className={`${styles.decorMark} ${decorCls}`}>{DECOR_MARK[decor]}</span>
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
  height: number
  decorations?: GitDecorations
}) {
  const dispatch = useAppDispatch()
  const fileTree = useAppSelector((s) => s.workspaceEditor.fileTree)
  const activePath = useAppSelector((s) => s.workspaceEditor.activeFilePath)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [fetchContent] = useLazyGetFileContentQuery()

  // ── Live change indicators ─────────────────────────────────────────────
  // path → { kind, clearTimer }
  const [liveChanges, setLiveChanges] = useState<Map<string, LiveChangeKind>>(new Map())
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const markChange = useCallback((path: string, kind: LiveChangeKind) => {
    // Clear any pending expiry for this path
    const existing = timersRef.current.get(path)
    if (existing) clearTimeout(existing)

    setLiveChanges((prev) => {
      const next = new Map(prev)
      next.set(path, kind)
      return next
    })

    // Auto-clear after TTL
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
  // This is additive to the tree invalidation done in useWorkspaceSocket —
  // that invalidation causes a refetch; this gives immediate visual feedback.
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
          // After a short delay, remove the deleted path from the map
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
      // Clear all timers on unmount
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

  if (!fileTree || rows.length === 0) {
    return (
      <div className={styles.empty} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, padding: 16, textAlign: 'center' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity={0.4}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
        <span style={{ fontSize: 11, lineHeight: 1.5, maxWidth: 160, opacity: 0.6 }}>
          {!workspaceId ? 'No workspace yet' : 'No files found in workspace'}
        </span>
      </div>
    )
  }

  return (
    <List
      rowCount={rows.length}
      rowHeight={26}
      rowComponent={Row}
      rowProps={{ rows, expanded, activePath, decorations, liveChanges, onToggle, onOpen }}
      style={{ height, width: '100%' }}
    />
  )
}
