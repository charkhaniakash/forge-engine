import { useMemo, useState } from 'react'
import { List, type RowComponentProps } from 'react-window'
import { Icon } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'
import { useLazyGetFileContentQuery } from '@/services/api/workspaceEditorApi'
import { languageForPath } from './language'
import type { FileNode } from '@/types/workspaceEditor'
import styles from './workspace.module.css'

export type GitChangeKind = 'staged' | 'modified' | 'untracked'
/** Map of repo-relative path → git change kind, for explorer decorations. */
export type GitDecorations = Map<string, GitChangeKind>

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
    // Skip the synthetic root itself; render its children at depth 0.
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
  onToggle: (path: string) => void
  onOpen: (node: FileNode) => void
}

function Row({ index, style, rows, expanded, activePath, decorations, onToggle, onOpen }: RowComponentProps<RowData>) {
  const { node, depth } = rows[index]
  const isDir = node.type === 'directory'
  const isOpen = expanded.has(node.path)
  const active = node.path === activePath
  const decor = !isDir ? decorations.get(node.path) : undefined
  const decorCls = decor ? DECOR_CLASS[decor] : ''
  return (
    <div
      style={{ ...style, paddingLeft: `calc(${depth} * var(--space-4) + var(--space-2))` }}
      className={`${styles.treeRow} ${active ? styles.treeRowActive : ''}`}
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
      {decor && <span className={`${styles.decorMark} ${decorCls}`}>{DECOR_MARK[decor]}</span>}
    </div>
  )
}

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

  const rows = useMemo(() => flatten(fileTree, expanded), [fileTree, expanded])

  const onToggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const onOpen = async (node: FileNode) => {
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
      // Non-fatal — the tab won't open if content can't be fetched.
    }
  }

  if (!fileTree || rows.length === 0) {
    return <div className={styles.empty}>No files</div>
  }

  return (
    <List
      rowCount={rows.length}
      rowHeight={26}
      rowComponent={Row}
      rowProps={{ rows, expanded, activePath, decorations, onToggle, onOpen }}
      style={{ height, width: '100%' }}
    />
  )
}
