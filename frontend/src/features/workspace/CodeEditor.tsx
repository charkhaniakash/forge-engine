import { useCallback, useEffect } from 'react'
import './monacoSetup' // configures Monaco to bundle locally (no CDN) — must run first
import Editor from '@monaco-editor/react'
import { Icon } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import {
  closeFile,
  markClean,
  resolveConflict,
  setActiveFile,
  updateFileContent,
} from '@/store/slices/workspaceEditorSlice'
import { useWriteFileMutation } from '@/services/api/workspaceEditorApi'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/lib/utils'

export interface CodeEditorProps {
  workspaceId: string
  fileExplorer?: React.ReactNode
  /** True while the agent is actively working — drives the "editing" pulse. */
  live?: boolean
}

export function CodeEditor({ workspaceId, fileExplorer, live = false }: CodeEditorProps) {
  const dispatch = useAppDispatch()
  const toast = useToast()
  const openFiles = useAppSelector((s) => s.workspaceEditor.openFiles)
  const activePath = useAppSelector((s) => s.workspaceEditor.activeFilePath)
  const conflicts = useAppSelector((s) => s.workspaceEditor.conflicts)
  const [writeFile, { isLoading: saving }] = useWriteFileMutation()

  const active = openFiles.find((f) => f.path === activePath) ?? null
  const inConflict = active ? conflicts[active.path] != null : false
  const crumbs = active ? active.path.split('/').filter(Boolean) : []

  const save = useCallback(async () => {
    if (!active) return
    try {
      await writeFile({ workspaceId, path: active.path, content: active.content }).unwrap()
      dispatch(markClean(active.path))
      toast.success(`Saved ${active.path.split('/').pop()}`)
    } catch {
      toast.error('Failed to save file')
    }
  }, [active, workspaceId, writeFile, dispatch, toast])

  // Ctrl/Cmd+S saves the active file.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* File explorer rail */}
      {fileExplorer && (
        <div className="flex w-60 flex-shrink-0 flex-col overflow-hidden border-r border-line bg-surface">
          <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-line-subtle px-3">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              Explorer
            </span>
            {live && (
              <span className="flex items-center gap-1 font-mono text-[10px] text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                live
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{fileExplorer}</div>
        </div>
      )}

      {/* Editor column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex h-9 flex-shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface">
          {openFiles.length === 0 ? (
            <span className="flex items-center px-3 text-xs text-fg-subtle">
              No files open — click a file to open it
            </span>
          ) : (
            openFiles.map((f) => {
              const name = f.path.split('/').pop() ?? f.path
              const isActive = f.path === activePath
              return (
                <div
                  key={f.path}
                  className={cn(
                    'group flex cursor-pointer items-center gap-1.5 border-r border-line-subtle px-3 text-xs transition-colors',
                    isActive
                      ? 'bg-card text-fg shadow-[inset_0_2px_0_0_var(--color-primary)]'
                      : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-muted',
                  )}
                  onClick={() => dispatch(setActiveFile(f.path))}
                  title={f.path}
                >
                  <Icon name="file" size={12} className="flex-shrink-0 opacity-70" />
                  <span className="max-w-40 truncate font-mono">{name}</span>
                  {f.dirty ? (
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-label="unsaved" />
                  ) : (
                    <span className="h-1.5 w-1.5 flex-shrink-0" />
                  )}
                  <button
                    className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      dispatch(closeFile(f.path))
                    }}
                    aria-label={`Close ${name}`}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* Breadcrumb path bar */}
        {active && (
          <div className="flex h-7 flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-line-subtle bg-surface px-3">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <Icon name="chevronRight" size={11} className="text-fg-subtle opacity-50" />}
                <span className={cn('font-mono text-[11px]', i === crumbs.length - 1 ? 'text-fg-muted' : 'text-fg-subtle')}>
                  {c}
                </span>
              </span>
            ))}
            {live && (
              <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                editing
              </span>
            )}
          </div>
        )}

        {/* Conflict banner */}
        {inConflict && active && (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <Icon name="alert" size={13} />
            <span className="text-fg-muted">File changed by agent while you had unsaved edits.</span>
            <button
              className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground transition-all hover:brightness-110 cursor-pointer"
              onClick={() => dispatch(resolveConflict({ path: active.path, keep: 'theirs' }))}
            >
              Use agent's version
            </button>
            <button
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-surface-2 cursor-pointer"
              onClick={() => dispatch(resolveConflict({ path: active.path, keep: 'mine' }))}
            >
              Keep mine
            </button>
          </div>
        )}

        {/* Editor or placeholder */}
        <div className="min-h-0 flex-1 bg-inset">
          {active ? (
            <Editor
              path={active.path}
              language={active.language}
              value={active.content}
              theme="vs-dark"
              onChange={(value) => {
                if (value != null && value !== active.content) {
                  dispatch(updateFileContent({ path: active.path, content: value }))
                }
              }}
              options={{
                minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
                fontSize: 13,
                lineHeight: 20,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontLigatures: true,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                tabSize: 2,
                readOnly: saving,
                renderLineHighlight: 'line',
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                padding: { top: 10, bottom: 10 },
                scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-2 text-fg-subtle">
                <Icon name="code" size={26} />
              </div>
              <p className="text-sm font-semibold text-fg-muted">No file open</p>
              <p className="max-w-[260px] text-xs leading-relaxed text-fg-subtle">
                Select a file from the explorer, or wait for the agent to start editing — files stream in here live.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
