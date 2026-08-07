import { Icon } from '@/components/common'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'
import { useLazyGetFileContentQuery } from '@/services/api/workspaceEditorApi'
import { languageForPath } from './language'
import type { DiagnosticItem } from '@/types/workspaceEditor'

function sevClass(sev: string): string {
  if (sev === 'error') return 'text-destructive'
  if (sev === 'warning') return 'text-warning'
  return 'text-info'
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
    return <div className="p-4 text-xs text-fg-subtle">No diagnostics. Build/test/lint issues appear here.</div>
  }

  return (
    <div className="flex flex-col p-2">
      {diagnostics.map((d) => (
        <div
          key={d.id}
          className="flex cursor-pointer gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-surface-2"
          onClick={() => onOpen(d)}
        >
          <span className={sevClass(d.severity)}>
            <Icon name={d.severity === 'error' ? 'x' : 'alert'} size={13} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg">{d.message}</div>
            <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">
              {d.file}{d.line != null ? `:${d.line}` : ''}{d.column != null ? `:${d.column}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
