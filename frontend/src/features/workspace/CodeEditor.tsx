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
import styles from './CodeEditor.module.css'

export function CodeEditor({ workspaceId }: { workspaceId: string }) {
  const dispatch = useAppDispatch()
  const toast = useToast()
  const openFiles = useAppSelector((s) => s.workspaceEditor.openFiles)
  const activePath = useAppSelector((s) => s.workspaceEditor.activeFilePath)
  const conflicts = useAppSelector((s) => s.workspaceEditor.conflicts)
  const [writeFile, { isLoading: saving }] = useWriteFileMutation()

  const active = openFiles.find((f) => f.path === activePath) ?? null
  const inConflict = active ? conflicts[active.path] != null : false

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
    <div className={styles.root}>
      {/* Tab bar */}
      <div className={styles.tabs}>
        {openFiles.length === 0 ? (
          <span className={styles.noFilesHint}>No files open — click a file to open it</span>
        ) : (
          openFiles.map((f) => {
            const name = f.path.split('/').pop() ?? f.path
            const isActive = f.path === activePath
            return (
              <div
                key={f.path}
                className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                onClick={() => dispatch(setActiveFile(f.path))}
                title={f.path}
              >
                <span className={styles.tabName}>{name}</span>
                {f.dirty && <span className={styles.dirtyDot} aria-label="unsaved" />}
                <button
                  className={styles.close}
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

      {/* Conflict banner */}
      {inConflict && active && (
        <div className={styles.conflict}>
          <Icon name="alert" size={13} />
          <span>File changed by agent while you had unsaved edits.</span>
          <button
            className={styles.conflictBtn}
            onClick={() => dispatch(resolveConflict({ path: active.path, keep: 'theirs' }))}
          >
            Use agent's version
          </button>
          <button
            className={styles.conflictBtnGhost}
            onClick={() => dispatch(resolveConflict({ path: active.path, keep: 'mine' }))}
          >
            Keep mine
          </button>
        </div>
      )}

      {/* Editor or placeholder */}
      <div className={styles.editor}>
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
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 20,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
              readOnly: saving,
              renderLineHighlight: 'line',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              fontLigatures: true,
            }}
          />
        ) : (
          <div className={styles.placeholder}>
            <Icon name="code" size={28} />
            <p className={styles.placeholderTitle}>No file open</p>
            <p className={styles.placeholderHint}>
              Select a file from the explorer, or wait for the agent to start editing
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
