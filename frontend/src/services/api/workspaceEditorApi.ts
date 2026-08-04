import { baseApi } from './baseApi'
import type {
  FileContent,
  FileNode,
  GitStatus,
  TerminalSession,
  WorkspaceHealth,
} from '@/types/workspaceEditor'

export interface PreviewSession {
  id: string
  workspace_id: string
  port: number
  command: string[]
  status: 'idle' | 'starting' | 'compiling' | 'ready' | 'error' | 'stopped'
  url: string
  started_at: string
}

/**
 * Phase 10B browser-IDE REST endpoints. Real-time data (file changes, terminal
 * output, timeline, …) arrives over the multiplexed WebSocket — these endpoints
 * are for initial loads and explicit actions only.
 */
export const workspaceEditorApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getFileTree: builder.query<{ tree: FileNode }, string>({
      query: (workspaceId) => `/workspace/${workspaceId}/files`,
      providesTags: ['WsFiles'],
    }),
    getFileContent: builder.query<FileContent, { workspaceId: string; path: string }>({
      query: ({ workspaceId, path }) =>
        `/workspace/${workspaceId}/files/${encodePath(path)}`,
      providesTags: (_r, _e, { path }) => [{ type: 'WsFileContent', id: path }],
    }),
    writeFile: builder.mutation<
      { written: number },
      { workspaceId: string; path: string; content: string }
    >({
      query: ({ workspaceId, path, content }) => ({
        url: `/workspace/${workspaceId}/files/${encodePath(path)}`,
        method: 'PUT',
        body: { content },
      }),
      invalidatesTags: (_r, _e, { path }) => [
        { type: 'WsFileContent', id: path },
        'WsGit',
      ],
    }),
    createTerminal: builder.mutation<
      TerminalSession,
      { workspaceId: string; cols?: number; rows?: number }
    >({
      query: ({ workspaceId, cols, rows }) => ({
        url: `/workspace/${workspaceId}/terminal`,
        method: 'POST',
        body: { cols: cols ?? 120, rows: rows ?? 30 },
      }),
    }),
    closeTerminal: builder.mutation<void, { workspaceId: string; terminalId: string }>({
      query: ({ workspaceId, terminalId }) => ({
        url: `/workspace/${workspaceId}/terminal/${terminalId}`,
        method: 'DELETE',
      }),
    }),
    getGitStatus: builder.query<GitStatus, string>({
      query: (workspaceId) => `/workspace/${workspaceId}/git/status`,
      providesTags: ['WsGit'],
    }),
    getGitDiff: builder.query<{ diff: string }, string>({
      query: (workspaceId) => `/workspace/${workspaceId}/git/diff`,
      providesTags: ['WsGit'],
    }),
    getWorkspaceHealth: builder.query<WorkspaceHealth, string>({
      query: (workspaceId) => `/workspace/${workspaceId}/health`,
    }),
    getProgress: builder.query<
      { status: string; current_step: number; total_steps: number; percent: number; current_action?: string; execution_id?: string },
      string
    >({
      query: (workspaceId) => `/workspace/${workspaceId}/progress`,
    }),
    pauseExecution: builder.mutation<void, string>({
      query: (workspaceId) => ({
        url: `/workspace/${workspaceId}/collaborate/pause`,
        method: 'POST',
      }),
    }),
    resumeExecution: builder.mutation<void, string>({
      query: (workspaceId) => ({
        url: `/workspace/${workspaceId}/collaborate/resume`,
        method: 'POST',
      }),
    }),
    stopExecution: builder.mutation<void, string>({
      query: (workspaceId) => ({
        url: `/workspace/${workspaceId}/collaborate/stop`,
        method: 'POST',
      }),
    }),
    // ── Preview (embedded dev-server) ───────────────────────────────────────
    getPreviewStatus: builder.query<PreviewSession | { status: string }, string>({
      query: (workspaceId) => `/workspace/${workspaceId}/preview`,
      providesTags: ['WsPreview'],
    }),
    startPreview: builder.mutation<
      PreviewSession,
      { workspaceId: string; command?: string[]; port?: number }
    >({
      query: ({ workspaceId, command, port }) => ({
        url: `/workspace/${workspaceId}/preview/start`,
        method: 'POST',
        body: { command, port },
      }),
      invalidatesTags: ['WsPreview'],
    }),
    stopPreview: builder.mutation<{ stopped: boolean }, string>({
      query: (workspaceId) => ({
        url: `/workspace/${workspaceId}/preview`,
        method: 'DELETE',
      }),
      invalidatesTags: ['WsPreview'],
    }),
  }),
})

/** Encode each path segment but keep the slashes (backend uses a wildcard route). */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export const {
  useGetFileTreeQuery,
  useLazyGetFileContentQuery,
  useWriteFileMutation,
  useCreateTerminalMutation,
  useCloseTerminalMutation,
  useGetGitStatusQuery,
  useGetGitDiffQuery,
  useGetWorkspaceHealthQuery,
  useGetProgressQuery,
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
  useGetPreviewStatusQuery,
  useStartPreviewMutation,
  useStopPreviewMutation,
} = workspaceEditorApi
