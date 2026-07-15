import { baseApi } from './baseApi'
import type {
  FileContent,
  FileNode,
  GitStatus,
  TerminalSession,
  WorkspaceHealth,
} from '@/types/workspaceEditor'

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
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
} = workspaceEditorApi
