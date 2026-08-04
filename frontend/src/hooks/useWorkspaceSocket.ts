import { useEffect } from 'react'
import { useAppDispatch } from '@/app/hooks'
import { useAuth } from './useAuth'
import { workspaceSocket } from '@/services/workspace/WorkspaceSocket'
import { workspaceEditorApi } from '@/services/api/workspaceEditorApi'
import {
  setConnectionStatus,
  externalFileModified,
  aiFileStreamed,
  setSessionId,
  workspaceOpened,
} from '@/store/slices/workspaceEditorSlice'
import { languageForPath } from '@/features/workspace/language'
import { terminalOutput } from '@/store/slices/workspaceTerminalSlice'
import {
  aiEventAppended,
  collaborationChanged,
  diagnosticsSet,
  diagnosticAppended,
  outputAppended,
  outputReset,
  timelineEventUpserted,
  transitionalActionSet,
  previewStarting,
  previewCompiling,
  previewReady,
  previewHMR,
  previewError,
  previewStopped,
} from '@/store/slices/workspaceActivitySlice'
import type { WSEnvelope, CollaborationStatus } from '@/types/workspaceEditor'
import { BACKEND_URL } from '@/constants/config'

const EXEC_LIVE_STATUSES = new Set(['pending', 'running', 'paused'])

/** Human-readable label for an ai_activity event. */
function aiLabel(ev: string, p: Record<string, unknown>): string {
  const tool = typeof p.tool === 'string' ? p.tool : undefined
  const msg  = typeof p.message === 'string' ? p.message : undefined
  const stage = typeof p.stage === 'string' ? p.stage : undefined
  switch (ev) {
    case 'reasoning':
    case 'repair_reasoning':      return msg ?? 'Thinking…'
    case 'tool_call':
    case 'repair_tool_call':      return tool ? `Calling ${tool}` : 'Tool call'
    case 'tool_result':
    case 'repair_tool_result':    return tool ? `${tool} finished` : 'Tool result'
    case 'deviation':             return msg ?? 'Plan deviation'
    case 'validation_stage':      return stage ? `Running ${stage}` : 'Validation'
    case 'repair_strategy': {
      const s = typeof p.strategy === 'string' ? p.strategy : undefined
      return s ? `Strategy: ${s}` : 'Repair planning'
    }
    case 'repair_attempt_started': {
      const a = typeof p.attempt_number === 'number' ? p.attempt_number : undefined
      return a ? `Repair attempt ${a}` : 'Repair attempt'
    }
    case 'publishing_step': {
      const st = typeof p.step === 'string' ? p.step : undefined
      return st ? `Publishing: ${st}` : 'Publishing'
    }
    default: return msg ?? ev
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

    const progressUrl = `${BACKEND_URL}/v1/workspace/${workspaceId}/progress`
    const previewUrl  = `${BACKEND_URL}/v1/workspace/${workspaceId}/preview`

    // Seed collaboration status immediately from REST (avoids waiting for WS replay)
    fetch(progressUrl, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && EXEC_LIVE_STATUSES.has(data.status)) {
          dispatch(collaborationChanged({
            status: data.status === 'paused' ? 'paused' : 'running',
            label: data.current_action
              ? `Step ${data.current_step} of ${data.total_steps}`
              : undefined,
          }))
        } else if (data?.status === 'completed') {
          dispatch(collaborationChanged({ status: 'completed' }))
        }
      })
      .catch(() => {})

    // Seed preview status immediately from REST
    fetch(previewUrl, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.status === 'ready' && data?.url) {
          dispatch(previewReady({ url: data.url, port: data.port ?? 0 }))
        } else if (data?.status === 'starting' || data?.status === 'compiling') {
          dispatch(previewStarting({ url: data.url ?? '', port: data.port ?? 0 }))
        }
      })
      .catch(() => {})

    workspaceSocket.connect(workspaceId, token)

    const asObj = (p: unknown): Record<string, unknown> =>
      p && typeof p === 'object' ? (p as Record<string, unknown>) : {}

    // ── Status handler ─────────────────────────────────────────────────────
    const offStatus = workspaceSocket.onStatus((s) => {
      dispatch(setConnectionStatus(s === 'connected' ? 'connected' : s))
      if (s === 'connected') {
        // On reconnect: clear transitional state and re-sync REST progress
        dispatch(transitionalActionSet(null))
        fetch(progressUrl, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (data && EXEC_LIVE_STATUSES.has(data.status)) {
              dispatch(collaborationChanged({
                status: data.status === 'paused' ? 'paused' : 'running',
                label: data.current_action
                  ? `Step ${data.current_step} of ${data.total_steps}`
                  : undefined,
              }))
            } else if (data?.status === 'completed') {
              dispatch(collaborationChanged({ status: 'completed' }))
            } else if (data?.status === 'cancelled') {
              dispatch(collaborationChanged({ status: 'stopped' }))
            }
          })
          .catch(() => {})
      }
    })

    const unsubs: Array<() => void> = []

    // ── system ─────────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('system', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'connected' && typeof p.session_id === 'string') {
          dispatch(setSessionId(p.session_id))
        }
      }),
    )

    // ── filesystem ─────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('filesystem', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        const path = typeof p.path === 'string' ? p.path : undefined
        const source = typeof p.source === 'string' ? p.source : undefined
        const content = typeof p.content === 'string' ? p.content : undefined

        // AI wrote/created a file WITH content → v0-style live view: auto-open
        // the file, focus it, and stream the edit into the editor. Applies to
        // both file_modified and file_created (new components the agent adds).
        if (source === 'ai' && content != null && path &&
            (env.ev === 'file_modified' || env.ev === 'file_created')) {
          dispatch(aiFileStreamed({ path, content, language: languageForPath(path) }))
          dispatch(workspaceEditorApi.util.invalidateTags([{ type: 'WsFileContent', id: path }]))
        } else if (env.ev === 'file_modified' && path && content != null) {
          // Non-AI (e.g. terminal/watcher) modification of an already-open file.
          dispatch(externalFileModified({ path, content }))
          dispatch(workspaceEditorApi.util.invalidateTags([{ type: 'WsFileContent', id: path }]))
        }

        // Structural changes → refetch the tree + git status
        if (
          env.ev === 'file_created' ||
          env.ev === 'file_deleted' ||
          env.ev === 'file_renamed' ||
          env.ev === 'files_may_have_changed'
        ) {
          dispatch(workspaceEditorApi.util.invalidateTags(['WsFiles', 'WsGit']))
        }

        if (env.ev === 'file_modified') {
          dispatch(workspaceEditorApi.util.invalidateTags(['WsGit']))
        }
      }),
    )

    // ── terminal ───────────────────────────────────────────────────────────
    const terminalSeqRef = new Map<string, number>()
    unsubs.push(
      workspaceSocket.subscribe('terminal', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'output' && typeof p.terminal_id === 'string' && typeof p.data === 'string') {
          const lastSeq = terminalSeqRef.get(p.terminal_id) ?? -1
          if (env.seq <= lastSeq) return      // deduplicate replayed events
          terminalSeqRef.set(p.terminal_id, env.seq)
          dispatch(terminalOutput({ terminalId: p.terminal_id, data: p.data }))
        }
      }),
    )

    // ── timeline ───────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('timeline', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        const phase  = typeof p.phase  === 'string' ? p.phase  : 'unknown'
        const step   = typeof p.step   === 'string' ? p.step   : ''
        const status = typeof p.status === 'string' ? p.status : 'running'
        dispatch(timelineEventUpserted({
          id:     step ? `${phase}:${step}` : `${phase}:${env.seq}`,
          phase,
          step:   step || phase,
          status,
          ts:     env.ts,
          detail: typeof p.message === 'string' ? p.message : undefined,
        }))
      }),
    )

    // ── ai_activity ────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('ai_activity', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        dispatch(aiEventAppended({
          id:    `ai-${env.seq}`,
          type:  env.ev,
          label: aiLabel(env.ev, p),
          tool:  typeof p.tool === 'string' ? p.tool : undefined,
          ts:    env.ts,
        }))
      }),
    )

    // ── collaboration ──────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('collaboration', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'control_requested') {
          const action = typeof p.action === 'string' ? p.action : ''
          if (action === 'pause')  dispatch(transitionalActionSet('pausing'))
          if (action === 'stop')   dispatch(transitionalActionSet('stopping'))
          if (action === 'resume') dispatch(transitionalActionSet('resuming'))
          return
        }
        const status = (typeof p.status === 'string' ? p.status : 'running') as CollaborationStatus
        dispatch(collaborationChanged({
          status,
          label: typeof p.label === 'string' ? p.label : undefined,
        }))
      }),
    )

    // ── diagnostics ────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('diagnostics', (env: WSEnvelope) => {
        const p = asObj(env.payload)
        if (env.ev === 'run_started') {
          dispatch(diagnosticsSet([]))
          dispatch(outputReset())
          dispatch(outputAppended('\x1b[1;36m● Validation started\x1b[0m\r\n'))
          return
        }
        if (env.ev === 'stage_started') {
          const stage = typeof p.stage   === 'string' ? p.stage : 'stage'
          const cmd   = Array.isArray(p.command) ? (p.command as unknown[]).join(' ') : ''
          dispatch(outputAppended(`\r\n\x1b[1;33m$ ${stage}${cmd ? ` — ${cmd}` : ''}\x1b[0m\r\n`))
          return
        }
        if (env.ev === 'stage_output') {
          const chunk = typeof p.chunk === 'string' ? p.chunk : ''
          if (chunk) dispatch(outputAppended(chunk))
          return
        }
        if (env.ev === 'stage_completed' || env.ev === 'stage_skipped') {
          const stage  = typeof p.stage === 'string' ? p.stage : 'stage'
          const passed = p.stage_passed !== false && env.ev !== 'stage_skipped'
          const mark   = env.ev === 'stage_skipped' ? 'skipped' : passed ? '✓ passed' : '✗ failed'
          const color  = env.ev === 'stage_skipped' ? '90' : passed ? '32' : '31'
          dispatch(outputAppended(`\r\n\x1b[1;${color}m${mark}: ${stage}\x1b[0m\r\n`))
          return
        }
        if (env.ev === 'items_added') {
          const stage = typeof p.stage === 'string' ? p.stage : ''
          const items = Array.isArray(p.items) ? p.items : []
          for (let i = 0; i < items.length; i++) {
            const d = items[i] as Record<string, unknown>
            const filePath = typeof d.file_path === 'string' ? d.file_path : ''
            const line     = typeof d.line_number === 'number' ? d.line_number : undefined
            const col      = typeof d.column_number === 'number' ? d.column_number : undefined
            dispatch(diagnosticAppended({
              id:       `${stage}:${filePath}:${line ?? i}`,
              severity: typeof d.severity === 'string' ? d.severity : 'error',
              file:     filePath,
              line,
              column:   col,
              message:  typeof d.message === 'string' ? d.message : '',
            }))
          }
        }
      }),
    )

    // ── git ────────────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('git', () => {
        dispatch(workspaceEditorApi.util.invalidateTags(['WsGit']))
      }),
    )

    // ── preview ────────────────────────────────────────────────────────────
    unsubs.push(
      workspaceSocket.subscribe('preview', (env: WSEnvelope) => {
        const p   = asObj(env.payload)
        const url  = typeof p.url  === 'string' ? p.url  : ''
        const port = typeof p.port === 'number' ? p.port : 0
        const msg  = typeof p.message === 'string' ? p.message : undefined

        switch (env.ev) {
          case 'preview_starting':
            dispatch(previewStarting({ url, port }))
            break
          case 'preview_installing':
          case 'preview_installed':
            // Installing node_modules before the dev server can start — keep the
            // panel in the "starting" (loading spinner) state throughout.
            dispatch(previewStarting({ url, port }))
            break
          case 'preview_compiling':
            dispatch(previewCompiling({ message: msg }))
            break
          case 'preview_ready':
            dispatch(previewReady({ url, port, message: msg }))
            break
          case 'preview_hmr': {
            const type = typeof p.type === 'string' ? p.type : 'update'
            dispatch(previewHMR({ type, message: msg }))
            break
          }
          case 'preview_build_error':
          case 'preview_error': {
            const error = typeof p.error === 'string' ? p.error : msg
            dispatch(previewError({ error }))
            break
          }
          case 'preview_stopped':
            dispatch(previewStopped())
            break
        }
      }),
    )

    return () => {
      offStatus()
      unsubs.forEach((u) => u())
      workspaceSocket.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, token])
}
