import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/app/hooks'
import { openFile, setActiveFile } from '@/store/slices/workspaceEditorSlice'
import { useLazyGetFileContentQuery } from '@/services/api/workspaceEditorApi'
import { languageForPath } from '@/features/workspace/language'

const TAB_MAX_AGE_MS = 5 * 60 * 1000

interface PersistedTabs {
  paths: string[]
  active: string | null
  timestamp: number
}

function tabsKey(workspaceId: string): string {
  return `workspace_tabs_${workspaceId}`
}

/**
 * Session recovery for editor tabs: restores the previously open files (and the
 * active one) on load, and persists the current set as it changes. Content is
 * re-fetched from the backend so restored tabs always reflect the latest disk
 * state. Complements the socket-level reconnect/replay in WorkspaceSocket.
 */
export function useWorkspaceTabs(workspaceId: string): void {
  const dispatch = useAppDispatch()
  const openFiles = useAppSelector((s) => s.workspaceEditor.openFiles)
  const activePath = useAppSelector((s) => s.workspaceEditor.activeFilePath)
  const [fetchContent] = useLazyGetFileContentQuery()

  const restoredFor = useRef<string | null>(null)
  const [restoreComplete, setRestoreComplete] = useState(false)

  // Restore once per workspace.
  useEffect(() => {
    if (!workspaceId || restoredFor.current === workspaceId) return
    restoredFor.current = workspaceId
    setRestoreComplete(false)

    let saved: PersistedTabs | null = null
    try {
      const raw = localStorage.getItem(tabsKey(workspaceId))
      if (raw) saved = JSON.parse(raw) as PersistedTabs
    } catch {
      saved = null
    }

    // Reading is synchronous and happens before the persist effect can clobber.
    setRestoreComplete(true)

    if (!saved || Date.now() - saved.timestamp > TAB_MAX_AGE_MS || saved.paths.length === 0) {
      return
    }

    void (async () => {
      for (const path of saved!.paths) {
        try {
          const res = await fetchContent({ workspaceId, path }).unwrap()
          dispatch(
            openFile({
              path,
              content: res.content ?? '',
              language: res.language ?? languageForPath(path),
              dirty: false,
            }),
          )
        } catch {
          // File may no longer exist — skip it.
        }
      }
      if (saved!.active) dispatch(setActiveFile(saved!.active))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Persist current tabs — only after the restore read, so we never overwrite
  // the saved set with the empty initial state.
  useEffect(() => {
    if (!workspaceId || !restoreComplete) return
    const data: PersistedTabs = {
      paths: openFiles.map((f) => f.path),
      active: activePath,
      timestamp: Date.now(),
    }
    try {
      localStorage.setItem(tabsKey(workspaceId), JSON.stringify(data))
    } catch {
      // ignore quota / unavailability
    }
  }, [workspaceId, openFiles, activePath, restoreComplete])
}
