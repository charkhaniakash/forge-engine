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
  timelineEventUpserted,
} from '@/store/slices/workspaceActivitySlice'
import type { WSEnvelope, CollaborationStatus } from '@/types/workspaceEditor'

/** Human-readable label for an ai_activity event. */
function aiLabel(ev: string, p: Record<string, unknown>): string {
  const tool = typeof p.tool === 'string' ? p.tool : undefined
  const msg = typeof p.message === 'string' ? p.message : undefined
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
    if (!workspaceId || !token) return
    dispatch(workspaceOpened(workspaceId))

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
        }
        // Structural changes → refresh the tree.
        if (
          env.ev === 'file_created' ||
          env.ev === 'file_deleted' ||
          env.ev === 'files_may_have_changed'
        ) {
          dispatch(workspaceEditorApi.util.invalidateTags(['WsFiles']))
        }
      }),
    )

    unsubs.push(
      workspaceSocket.subscribe('terminal', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'output' && typeof p.terminal_id === 'string' && typeof p.data === 'string') {
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
