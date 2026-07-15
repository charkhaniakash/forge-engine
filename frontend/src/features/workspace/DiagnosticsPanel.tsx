import { Icon } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'
import { useLazyGetFileContentQuery } from '@/services/api/workspaceEditorApi'
import { languageForPath } from './language'
import type { DiagnosticItem } from '@/types/workspaceEditor'
import styles from './workspace.module.css'

function sevClass(sev: string): string {
  if (sev === 'error') return styles.sevError
  if (sev === 'warning') return styles.sevWarning
  return styles.sevInfo
}

export function DiagnosticsPanel({ workspaceId }: { workspaceId: string }) {
  const dispatch = useAppDispatch()
  const diagnostics = useAppSelector((s) => s.workspaceActivity.diagnostics)
  const openFiles = useAppSelector((s) => s.workspaceEditor.openFiles)
  const [fetchContent] = useLazyGetFileContentQuery()

  const onOpen = async (d: DiagnosticItem) => {
    if (!d.file) return
    if (openFiles.some((f) => f.path === d.file)) {
      dispatch(setActiveFile(d.file))
      return
    }
    try {
      const res = await fetchContent({ workspaceId, path: d.file }).unwrap()
      dispatch(
        openFile({
          path: d.file,
          content: res.content ?? '',
          language: res.language ?? languageForPath(d.file),
          dirty: false,
        }),
      )
    } catch {
      // ignore — file may no longer exist
    }
  }

  if (diagnostics.length === 0) {
    return <div className={styles.empty}>No diagnostics. Build/test/lint issues appear here.</div>
  }

  return (
    <div>
      {diagnostics.map((d) => (
        <div key={d.id} className={styles.diagRow} onClick={() => onOpen(d)}>
          <span className={sevClass(d.severity)}>
            <Icon name={d.severity === 'error' ? 'x' : 'alert'} size={13} />
          </span>
          <div>
            <div>{d.message}</div>
            <div className={styles.diagLoc}>
              {d.file}{d.line != null ? `:${d.line}` : ''}{d.column != null ? `:${d.column}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
