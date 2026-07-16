import { useEffect } from 'react'
import { useAppDispatch } from '@/app/hooks'
import { useAuth } from './useAuth'
import { workspaceSocket } from '@/services/workspace/WorkspaceSocket'
import { workspaceEditorApi } from '@/services/api/workspaceEditorApi'
import {
  setConnectionStatus,
  externalFileModified,
  setSessionId,
  workspaceOpened,
} from '@/store/slices/workspaceEditorSlice'
import { terminalOutput } from '@/store/slices/workspaceTerminalSlice'
import {
  aiEventAppended,
  collaborationChanged,
  diagnosticsSet,
  diagnosticAppended,
  outputAppended,
  outputReset,
  timelineEventUpserted,
} from '@/store/slices/workspaceActivitySlice'
import type { WSEnvelope, CollaborationStatus } from '@/types/workspaceEditor'

/** Human-readable label for an ai_activity event. */
function aiLabel(ev: string, p: Record<string, unknown>): string {
  const tool = typeof p.tool === 'string' ? p.tool : undefined
  const msg = typeof p.message === 'string' ? p.message : undefined
  const stage = typeof p.stage === 'string' ? p.stage : undefined
  switch (ev) {
    case 'reasoning':
    case 'repair_reasoning':
      return msg ?? 'Thinking…'
    case 'tool_call':
    case 'repair_tool_call':
      return tool ? `Calling ${tool}` : 'Tool call'
    case 'tool_result':
    case 'repair_tool_result':
      return tool ? `${tool} finished` : 'Tool result'
    case 'deviation':
      return msg ?? 'Plan deviation'
    case 'validation_stage':
      return stage ? `Running ${stage}` : 'Validation'
    case 'repair_strategy':
      const strategy = typeof p.strategy === 'string' ? p.strategy : undefined
      return strategy ? `Strategy: ${strategy}` : 'Repair planning'
    case 'repair_attempt_started':
      const attempt = typeof p.attempt_number === 'number' ? p.attempt_number : undefined
      return attempt ? `Repair attempt ${attempt}` : 'Repair attempt'
    case 'publishing_step':
      const step = typeof p.step === 'string' ? p.step : undefined
      return step ? `Publishing: ${step}` : 'Publishing'
    default:
      return msg ?? ev
  }
}

/**
 * Connects the single multiplexed workspace socket and fans every inbound
 * envelope into the appropriate Redux slice. Owns the connection for the
 * lifetime of the workspace page.
 */
export function useWorkspaceSocket(workspaceId: string): void {
  const dispatch = useAppDispatch()
  const { token } = useAuth()

  useEffect(() => {
    if (!workspaceId || !token) {
      console.log('[useWorkspaceSocket] Missing workspaceId or token', { workspaceId, hasToken: !!token })
      return
    }
    console.log('[useWorkspaceSocket] Connecting to workspace', workspaceId)
    dispatch(workspaceOpened(workspaceId))

    // Connect to the workspace WebSocket
    workspaceSocket.connect(workspaceId, token)

    const asObj = (p: unknown): Record<string, unknown> =>
      p && typeof p === 'object' ? (p as Record<string, unknown>) : {}

    const offStatus = workspaceSocket.onStatus((s) => {
      dispatch(setConnectionStatus(s === 'connected' ? 'connected' : s))
    })

    const unsubs: Array<() => void> = []

    unsubs.push(
      workspaceSocket.subscribe('system', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'connected' && typeof p.session_id === 'string') {
          dispatch(setSessionId(p.session_id))
        }
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('filesystem', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        const path = typeof p.path === 'string' ? p.path : undefined
        if (env.ev === 'file_modified' && path && typeof p.content === 'string') {
          // AI (or another client) changed the file — reflect it live in the
          // editor, or raise a conflict if the user has unsaved edits.
          dispatch(externalFileModified({ path, content: p.content }))
          // Drop the stale cached content so a reopen fetches fresh bytes.
          dispatch(
            workspaceEditorApi.util.invalidateTags([{ type: 'WsFileContent', id: path }]),
          )
        }
        // Structural changes → refresh the tree + git status (a created/deleted
        // file changes the working tree).
        if (
          env.ev === 'file_created' ||
          env.ev === 'file_deleted' ||
          env.ev === 'files_may_have_changed'
        ) {
          dispatch(workspaceEditorApi.util.invalidateTags(['WsFiles', 'WsGit']))
        }
        // Any content modification also dirties the git working tree — refresh.
        if (env.ev === 'file_modified') {
          dispatch(workspaceEditorApi.util.invalidateTags(['WsGit']))
        }
      }),
    )

    console.log('[useWorkspaceSocket] Setting up terminal subscription')
    const terminalSeqRef = new Map<string, number>()
    unsubs.push(
      workspaceSocket.subscribe('terminal', (env: WSEnvelope) => {
        console.log('[useWorkspaceSocket] terminal event received', { ev: env.ev, payload: env.payload, seq: env.seq })
        const p = asObj(env.payload)
        if (env.ev === 'output' && typeof p.terminal_id === 'string' && typeof p.data === 'string') {
          // Deduplicate by sequence number
          const lastSeq = terminalSeqRef.get(p.terminal_id) ?? -1
          if (env.seq <= lastSeq) {
            console.log('[useWorkspaceSocket] Skipping duplicate terminal output', { terminalId: p.terminal_id, seq: env.seq, lastSeq })
            return
          }
          terminalSeqRef.set(p.terminal_id, env.seq)
          console.log('[useWorkspaceSocket] terminal output dispatching', { terminalId: p.terminal_id, dataLength: p.data.length, seq: env.seq })
          dispatch(terminalOutput({ terminalId: p.terminal_id, data: p.data }))
        }
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('timeline', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        const phase = typeof p.phase === 'string' ? p.phase : 'unknown'
        const step = typeof p.step === 'string' ? p.step : ''
        const status = typeof p.status === 'string' ? p.status : 'running'
        dispatch(
          timelineEventUpserted({
            id: step ? `${phase}:${step}` : `${phase}:${env.seq}`,
            phase,
            step: step || phase,
            status,
            ts: env.ts,
            detail: typeof p.message === 'string' ? p.message : undefined,
          }),
        )
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('ai_activity', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        dispatch(
          aiEventAppended({
            id: `ai-${env.seq}`,
            type: env.ev,
            label: aiLabel(env.ev, p),
            tool: typeof p.tool === 'string' ? p.tool : undefined,
            ts: env.ts,
          }),
        )
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('collaboration', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        const status = (typeof p.status === 'string' ? p.status : 'running') as CollaborationStatus
        dispatch(
          collaborationChanged({
            status,
            label: typeof p.label === 'string' ? p.label : undefined,
          }),
        )
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('diagnostics', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'run_started') {
          // New validation run starting — clear stale diagnostics + output.
          dispatch(diagnosticsSet([]))
          dispatch(outputReset())
          dispatch(outputAppended('\x1b[1;36m● Validation started\x1b[0m\r\n'))
          return
        }
        if (env.ev === 'stage_started') {
          // Header line so the live output reads like a terminal: "$ npm run build".
          const stage = typeof p.stage === 'string' ? p.stage : 'stage'
          const cmd = Array.isArray(p.command) ? (p.command as unknown[]).join(' ') : ''
          dispatch(outputAppended(`\r\n\x1b[1;33m$ ${stage}${cmd ? ` — ${cmd}` : ''}\x1b[0m\r\n`))
          return
        }
        if (env.ev === 'stage_output') {
          // Live command output chunk (install/build/test/lint).
          const chunk = typeof p.chunk === 'string' ? p.chunk : ''
          if (chunk) dispatch(outputAppended(chunk))
          return
        }
        if (env.ev === 'stage_completed' || env.ev === 'stage_skipped') {
          const stage = typeof p.stage === 'string' ? p.stage : 'stage'
          const passed = p.stage_passed !== false && env.ev !== 'stage_skipped'
          const mark = env.ev === 'stage_skipped' ? 'skipped' : passed ? '✓ passed' : '✗ failed'
          const color = env.ev === 'stage_skipped' ? '90' : passed ? '32' : '31'
          dispatch(outputAppended(`\r\n\x1b[1;${color}m${mark}: ${stage}\x1b[0m\r\n`))
          return
        }
        if (env.ev === 'items_added') {
          const stage = typeof p.stage === 'string' ? p.stage : ''
          const items = Array.isArray(p.items) ? p.items : []
          for (let i = 0; i < items.length; i++) {
            const d = items[i] as Record<string, unknown>
            const filePath = typeof d.file_path === 'string' ? d.file_path : ''
            const line = typeof d.line_number === 'number' ? d.line_number : undefined
            const col = typeof d.column_number === 'number' ? d.column_number : undefined
            dispatch(
              diagnosticAppended({
                id: `${stage}:${filePath}:${line ?? i}`,
                severity: typeof d.severity === 'string' ? d.severity : 'error',
                file: filePath,
                line,
                column: col,
                message: typeof d.message === 'string' ? d.message : '',
              }),
            )
          }
        }
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('git', () => {
        dispatch(workspaceEditorApi.util.invalidateTags(['WsGit']))
      }),
    )

    workspaceSocket.connect(workspaceId, token)

    return () => {
      offStatus()
      unsubs.forEach((u) => u())
      workspaceSocket.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, token])
}
