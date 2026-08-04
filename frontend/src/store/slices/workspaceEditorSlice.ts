import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  ConnectionStatus,
  FileNode,
  GitStatus,
  OpenFile,
  WorkspaceHealth,
} from '@/types/workspaceEditor'

interface WorkspaceEditorState {
  workspaceId: string | null
  sessionId: string | null
  connectionStatus: ConnectionStatus
  fileTree: FileNode | null
  openFiles: OpenFile[]
  activeFilePath: string | null
  gitStatus: GitStatus | null
  health: WorkspaceHealth | null
  /** path → external (AI) content that arrived while the buffer was dirty. */
  conflicts: Record<string, string>
}

const initialState: WorkspaceEditorState = {
  workspaceId: null,
  sessionId: null,
  connectionStatus: 'idle',
  fileTree: null,
  openFiles: [],
  activeFilePath: null,
  gitStatus: null,
  health: null,
  conflicts: {},
}

const slice = createSlice({
  name: 'workspaceEditor',
  initialState,
  reducers: {
    workspaceOpened(state, action: PayloadAction<string>) {
      // Reset editor state when a (different) workspace is opened.
      if (state.workspaceId !== action.payload) {
        Object.assign(state, initialState)
      }
      state.workspaceId = action.payload
    },
    setConnectionStatus(state, action: PayloadAction<ConnectionStatus>) {
      state.connectionStatus = action.payload
    },
    setSessionId(state, action: PayloadAction<string>) {
      state.sessionId = action.payload
    },
    setFileTree(state, action: PayloadAction<FileNode>) {
      state.fileTree = action.payload
    },
    openFile(state, action: PayloadAction<OpenFile>) {
      const existing = state.openFiles.find((f) => f.path === action.payload.path)
      if (!existing) {
        state.openFiles.push(action.payload)
      }
      state.activeFilePath = action.payload.path
    },
    closeFile(state, action: PayloadAction<string>) {
      const idx = state.openFiles.findIndex((f) => f.path === action.payload)
      if (idx === -1) return
      state.openFiles.splice(idx, 1)
      if (state.activeFilePath === action.payload) {
        const next = state.openFiles[idx] ?? state.openFiles[idx - 1] ?? null
        state.activeFilePath = next ? next.path : null
      }
    },
    setActiveFile(state, action: PayloadAction<string>) {
      state.activeFilePath = action.payload
    },
    /** Local edit in the editor — marks the buffer dirty (unsaved). */
    updateFileContent(state, action: PayloadAction<{ path: string; content: string }>) {
      const f = state.openFiles.find((x) => x.path === action.payload.path)
      if (f) {
        f.content = action.payload.content
        f.dirty = true
      }
    },
    /** External update (AI wrote the file, or a successful save) — not dirty. */
    setFileContentClean(state, action: PayloadAction<{ path: string; content: string }>) {
      const f = state.openFiles.find((x) => x.path === action.payload.path)
      if (f) {
        f.content = action.payload.content
        f.dirty = false
      }
    },
    /**
     * The AI (or another client) modified a file on disk. If our buffer is
     * clean we take the new content; if it's dirty we DON'T clobber the user's
     * edits — we record a conflict for them to resolve.
     */
    externalFileModified(state, action: PayloadAction<{ path: string; content: string }>) {
      const { path, content } = action.payload
      const f = state.openFiles.find((x) => x.path === path)
      if (!f) return
      if (f.dirty) {
        state.conflicts[path] = content
      } else {
        f.content = content
      }
    },
    /**
     * The AI wrote/created a file. v0-style: auto-open the file, make it the
     * active tab, and live-update its content so the user watches the edit
     * happen. If the user has unsaved local edits to that file, don't clobber
     * them — raise a conflict instead.
     */
    aiFileStreamed(
      state,
      action: PayloadAction<{ path: string; content: string; language: string }>,
    ) {
      const { path, content, language } = action.payload
      const f = state.openFiles.find((x) => x.path === path)
      if (!f) {
        state.openFiles.push({ path, content, language, dirty: false })
      } else if (f.dirty) {
        state.conflicts[path] = content
      } else {
        f.content = content
      }
      // Focus the file the agent is currently editing (unless the user is
      // mid-edit on a different file they haven't saved).
      const activeDirty = state.openFiles.find(
        (x) => x.path === state.activeFilePath,
      )?.dirty
      if (!activeDirty) {
        state.activeFilePath = path
      }
    },
    resolveConflict(state, action: PayloadAction<{ path: string; keep: 'mine' | 'theirs' }>) {
      const { path, keep } = action.payload
      const incoming = state.conflicts[path]
      if (keep === 'theirs' && incoming != null) {
        const f = state.openFiles.find((x) => x.path === path)
        if (f) {
          f.content = incoming
          f.dirty = false
        }
      }
      delete state.conflicts[path]
    },
    markClean(state, action: PayloadAction<string>) {
      const f = state.openFiles.find((x) => x.path === action.payload)
      if (f) f.dirty = false
    },
    setGitStatus(state, action: PayloadAction<GitStatus>) {
      state.gitStatus = action.payload
    },
    setHealth(state, action: PayloadAction<WorkspaceHealth>) {
      state.health = action.payload
    },
    resetWorkspaceEditor() {
      return initialState
    },
  },
})

export const {
  workspaceOpened,
  setConnectionStatus,
  setSessionId,
  setFileTree,
  openFile,
  closeFile,
  setActiveFile,
  updateFileContent,
  setFileContentClean,
  externalFileModified,
  aiFileStreamed,
  resolveConflict,
  markClean,
  setGitStatus,
  setHealth,
  resetWorkspaceEditor,
} = slice.actions

export default slice.reducer
