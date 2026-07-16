# Phase 10B Frontend Implementation — Complete Prompt for Claude Code

## Project Context

You are implementing the frontend for Phase 10B of Forge Engine — a Cloud Development Workspace (Browser IDE). The backend is already complete and exposes all the APIs listed below.

**Tech stack:** React 18, TypeScript, Vite, Redux Toolkit (RTK Query), CSS Modules, React Router v6.

**Existing project structure:**
```
frontend/src/
├── app/           — store.ts, hooks.ts, router.tsx, providers/
├── components/    — common/ (Button, Icon, Badge, Spinner, etc.)
├── constants/     — config.ts, routes.ts, status.ts
├── features/      — planning/, qa/, repositories/, task-workspace/
├── hooks/         — useAuth.ts, useSocketChannel.ts, useToast.ts
├── pages/         — Console/, TaskWorkspace/, Login/, Signup/, etc.
├── services/      — api/ (baseApi.ts + domain apis), websocket/
├── store/         — slices/, middleware/, actions/
├── styles/        — global.css, tokens.css
├── types/         — per-domain type files
└── main.tsx
```

**Existing patterns you MUST follow:**
- RTK Query for all REST API calls (inject into `baseApi`)
- Redux slices with `createSlice` for local state
- CSS Modules (`.module.css`) for styling — uses design tokens from `styles/tokens.css`
- `useAuth()` hook for JWT token access
- `websocketBase()` from `constants/config.ts` for WebSocket URLs
- Lazy loading for pages in `router.tsx`

---

## New Dependencies to Install

```bash
npm install @monaco-editor/react monaco-editor @xterm/xterm @xterm/addon-fit react-window @types/react-window
```

---

## What to Build

### 1. New Route

Add to `app/router.tsx`:
```typescript
{ path: '/workspace/:workspaceId', element: <Workspace /> }  // lazy loaded
```

### 2. Types (`types/workspace.ts`)

```typescript
// WebSocket envelope
export interface WSEnvelope {
  ch: string
  ev: string
  seq: number
  ts: number
  payload: any
}

// Client → Server messages
export interface WSClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'channel_msg' | 'reconnect' | 'ping'
  channels?: string[]
  ch?: string
  ev?: string
  payload?: any
  session_id?: string
  last_seq?: Record<string, number>
}

// File tree
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content: string
  size: number
  language?: string
}

// Terminal
export interface TerminalSession {
  id: string
  workspace_id: string
  cols: number
  rows: number
  status: 'active' | 'closed'
  created_at: string
}

// Git
export interface GitStatus {
  branch: string
  modified: string[]
  staged: string[]
  untracked: string[]
}

// Health
export interface WorkspaceHealth {
  container: { status: string }
  workspace: { status: string; active_terminals: number }
}

// Channels
export type WSChannel =
  | 'system'
  | 'filesystem'
  | 'terminal'
  | 'execution'
  | 'validation'
  | 'repair'
  | 'publishing'
  | 'git'
  | 'diagnostics'
  | 'timeline'
  | 'ai_activity'
  | 'collaboration'
```

### 3. WebSocket Manager (`services/workspace/WorkspaceSocket.ts`)

Create a class that manages a SINGLE multiplexed WebSocket connection:

```typescript
class WorkspaceSocketManager {
  private ws: WebSocket | null = null
  private listeners: Map<string, Set<(event: WSEnvelope) => void>> = new Map()
  private lastSeq: Map<string, number> = new Map()
  private sessionId: string | null = null
  private reconnectAttempts = 0
  private workspaceId: string = ''
  private token: string = ''

  connect(workspaceId: string, token: string): void {
    // Connect to: ${websocketBase()}/workspace/${workspaceId}/stream?token=${token}
    // On open: store sessionId from 'system.connected' event
    // On message: parse JSON as WSEnvelope, update lastSeq, dispatch to listeners
    // On close: auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, 15s cap)
    // On reconnect: send {type:'reconnect', session_id, last_seq} to get missed events
  }

  subscribe(channel: string, handler: (event: WSEnvelope) => void): () => void {
    // Add handler to listeners map for this channel
    // Send {type:'subscribe', channels:[channel]} if not already subscribed
    // Return unsubscribe function
  }

  send(channel: string, event: string, payload: any): void {
    // Send {type:'channel_msg', ch:channel, ev:event, payload}
  }

  disconnect(): void {
    // Close WebSocket, clear state
  }
}
```

Persist `lastSeq` to localStorage so reconnects can replay missed events.

### 4. Redux Slices

**`store/slices/workspaceEditorSlice.ts`:**
```typescript
interface WorkspaceEditorState {
  workspaceId: string | null
  sessionId: string | null
  connectionStatus: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
  fileTree: FileNode | null
  openFiles: Array<{ path: string; content: string; language: string; dirty: boolean }>
  activeFilePath: string | null
  gitStatus: GitStatus | null
  health: WorkspaceHealth | null
}
```

Reducers: `setConnected`, `setDisconnected`, `setFileTree`, `openFile`, `closeFile`, `setActiveFile`, `updateFileContent`, `markDirty`, `setGitStatus`, `setHealth`

**`store/slices/workspaceTerminalSlice.ts`:**
```typescript
interface TerminalState {
  sessions: Record<string, { id: string; status: string }>
  activeTerminalId: string | null
  output: Record<string, string[]>  // terminalId → output lines
}
```

**`store/slices/workspaceActivitySlice.ts`:**
```typescript
interface ActivityState {
  timeline: Array<{ id: string; phase: string; step: string; status: string; ts: number }>
  aiEvents: Array<{ type: string; label: string; tool?: string; ts: number }>
  collaboration: { status: 'running' | 'paused' | 'stopped' | 'completed' }
}
```

### 5. RTK Query API (`services/api/workspaceEditorApi.ts`)

Inject into baseApi:

```typescript
endpoints: (builder) => ({
  getFileTree: builder.query<{ tree: FileNode }, string>({
    query: (workspaceId) => `/workspace/${workspaceId}/files`,
  }),
  getFileContent: builder.query<FileContent, { workspaceId: string; path: string }>({
    query: ({ workspaceId, path }) => `/workspace/${workspaceId}/files/${path}`,
  }),
  writeFile: builder.mutation<{ written: number }, { workspaceId: string; path: string; content: string }>({
    query: ({ workspaceId, path, content }) => ({
      url: `/workspace/${workspaceId}/files/${path}`,
      method: 'PUT',
      body: { content },
    }),
  }),
  createTerminal: builder.mutation<TerminalSession, { workspaceId: string; cols?: number; rows?: number }>({
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
  }),
  getGitDiff: builder.query<{ diff: string }, string>({
    query: (workspaceId) => `/workspace/${workspaceId}/git/diff`,
  }),
  getHealth: builder.query<WorkspaceHealth, string>({
    query: (workspaceId) => `/workspace/${workspaceId}/health`,
    pollingInterval: 10000,
  }),
  pauseExecution: builder.mutation<void, string>({
    query: (workspaceId) => ({ url: `/workspace/${workspaceId}/collaborate/pause`, method: 'POST' }),
  }),
  resumeExecution: builder.mutation<void, string>({
    query: (workspaceId) => ({ url: `/workspace/${workspaceId}/collaborate/resume`, method: 'POST' }),
  }),
  stopExecution: builder.mutation<void, string>({
    query: (workspaceId) => ({ url: `/workspace/${workspaceId}/collaborate/stop`, method: 'POST' }),
  }),
})
```

### 6. Page Layout (`pages/Workspace/Workspace.tsx`)

Full-screen IDE layout — NO app header, NO side navigation. Just the workspace.

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Toolbar: workspace name | health dot | pause | resume | stop]      │
├──────────┬──────────────────────────────────────┬───────────────────┤
│          │                                      │                   │
│  File    │     Monaco Editor                    │  Right Panel      │
│  Explorer│     (with tabs)                      │  ┌─────────────┐  │
│          │                                      │  │ Timeline    │  │
│  ────────│                                      │  │ AI Activity │  │
│  Git     │                                      │  │ Terminal    │  │
│  Status  │                                      │  │ Diagnostics │  │
│          │                                      │  └─────────────┘  │
│          │                                      │                   │
├──────────┴──────────────────────────────────────┴───────────────────┤
│ [Status bar: branch | connection status | file count]               │
└─────────────────────────────────────────────────────────────────────┘
```

**Left panel (250px, resizable):**
- File Explorer (virtualized tree with react-window)
- Git Status summary (modified/staged/untracked counts)

**Center panel (flex):**
- Tab bar (open files — click to switch, × to close, dot for unsaved)
- Monaco Editor (language-aware, shows current file)
- Keyboard shortcut: Ctrl+S saves to backend

**Right panel (350px, resizable, tabbed):**
- Timeline tab: execution events (planning → executing → validation → repair → publishing)
- AI Activity tab: live reasoning, tool calls, file reads/writes
- Terminal tab: xterm.js terminal (commands via WebSocket)
- Diagnostics tab: build/test/lint errors with click-to-navigate
- Git tab: full diff view

### 7. Components

**`features/workspace/FileExplorer.tsx`:**
- Use react-window `FixedSizeList` for virtualization
- Click file → dispatch `openFile` + fetch content via RTK Query
- Directories expand/collapse (arrow icon)
- File type icons (folder, ts, go, py, etc.)
- Highlight currently active file

**`features/workspace/CodeEditor.tsx`:**
- `@monaco-editor/react` — controlled via Redux `activeFilePath` + `fileContents`
- Tab bar above editor showing all open files
- When WebSocket sends `filesystem.file_modified` for an open file → update the model
- Show conflict banner if user has unsaved changes AND AI modifies the same file
- Language detection from file extension

**`features/workspace/TerminalPanel.tsx`:**
- `@xterm/xterm` with `@xterm/addon-fit`
- On mount: `POST /workspace/:id/terminal` → get terminal_id
- Subscribe to WebSocket channel `terminal`
- On `terminal.output` events → write to xterm
- On user keypress → send via WebSocket: `{type:'channel_msg', ch:'terminal', ev:'input', payload:{terminal_id, data}}`
- Auto-fit on panel resize

**`features/workspace/TimelinePanel.tsx`:**
- List of timeline events from `timeline` WebSocket channel
- Each event: phase icon + step title + status badge + timestamp
- Color-coded by status: running=blue, success=green, failed=red
- Click event → expand to show logs/affected files

**`features/workspace/AIActivityFeed.tsx`:**
- Live feed from `ai_activity` WebSocket channel
- Events: 💭 reasoning, 📖 reading file, ✏️ writing file, 🔍 searching, 🔧 tool call
- Most recent at bottom, auto-scroll
- Shows what the AI is doing RIGHT NOW

**`features/workspace/GitPanel.tsx`:**
- Shows modified/staged/untracked file lists from `GET /workspace/:id/git/status`
- Click file → open Monaco diff editor (show before/after)
- Refresh on `git.status_changed` WebSocket events
- Show current branch name

**`features/workspace/DiagnosticsPanel.tsx`:**
- List of errors/warnings from `diagnostics` WebSocket channel
- Each item: severity icon + file:line + message
- Click → opens file in editor at that line (dispatch `openFile` with scroll position)

**`features/workspace/CollaborationBar.tsx`:**
- Part of the top toolbar
- Pause button (shows when execution is running)
- Resume button (shows when paused)
- Stop button (always visible during execution)
- Status label: "Running Step 3 of 5" or "Paused" or "Completed"
- Updates from `collaboration.state_changed` WebSocket events

### 8. WebSocket Event Handling

When the workspace page mounts:
1. Call `socket.connect(workspaceId, token)`
2. Subscribe to: `filesystem`, `terminal`, `timeline`, `ai_activity`, `collaboration`, `system`, `git`, `diagnostics`
3. Dispatch events to Redux based on channel:
   - `filesystem.file_modified` → update file content in store
   - `filesystem.file_created` → add to tree
   - `filesystem.file_deleted` → remove from tree
   - `terminal.output` → append to terminal buffer
   - `terminal.created` → add session
   - `terminal.closed` → remove session
   - `timeline.event_added` / `timeline.event_completed` → update timeline
   - `ai_activity.*` → append to AI feed
   - `collaboration.state_changed` → update execution state
   - `git.status_changed` → refetch git status
   - `diagnostics.*` → update diagnostics list
   - `system.connected` → store sessionId
   - `system.health` → update health indicator

### 9. Navigation from TaskWorkspace

In the existing `TaskWorkspace.tsx`, add an "Open IDE" button that appears when:
- A workspace exists and is in `ready` or `running` status
- Links to: `/workspace/${workspaceId}?task=${taskId}`

### 10. Key UX Requirements

- The workspace page is a FULL SCREEN IDE — no navigation chrome from the app
- File changes from the AI appear instantly in the editor (no refresh needed)
- Terminal works like a real shell (command → output → command)
- "Reconnecting..." banner appears when WebSocket disconnects
- Green/yellow/red health dot in toolbar shows workspace status
- Cmd+S / Ctrl+S saves the current file to the backend
- All panels are independently scrollable
- The workspace continues running even if the browser tab is closed (reconnect catches up)

### 11. Session Recovery

Store in localStorage (`workspace_session_${workspaceId}`):
```typescript
{
  sessionId: string
  openFiles: string[]       // paths
  activeFilePath: string
  lastSeq: Record<string, number>  // per channel
  timestamp: number
}
```

On page load:
1. Read from localStorage
2. If session exists and < 5 min old → send `reconnect` message with `last_seq`
3. Re-open previously open file tabs
4. Resume receiving events from where you left off

---

## Important Constraints

- DO NOT create a separate WebSocket for each panel (use the single multiplexed connection)
- DO NOT poll REST APIs for real-time data (use WebSocket events)
- DO NOT fabricate or simulate AI activity (only show what the backend sends)
- DO follow existing Redux/RTK patterns from the project
- DO use CSS Modules with design tokens (var(--space-2), var(--text-sm), etc.)
- DO use existing common components (Button, Icon, Badge, Spinner, StatusBadge)
- The workspace ID comes from the URL param `:workspaceId`
