import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from '@/components/common'
import { useAppSelector, useAppDispatch } from '@/app/hooks'
import {
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
} from '@/services/api/workspaceEditorApi'
import { transitionalActionSet } from '@/store/slices/workspaceActivitySlice'
import { useToast } from '@/hooks/useToast'
import type { MissionPhase } from './useMissionPhase'
import { cn } from '@/lib/utils'

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Completed',
  idle: 'Idle',
}

/** Emoji glyph for an ai_activity event type. */
function glyph(type: string): string {
  if (type.includes('reasoning')) return '💭'
  if (type.includes('tool_call')) return '🔧'
  if (type.includes('tool_result')) return '✅'
  if (type.includes('read')) return '📖'
  if (type.includes('write')) return '✏️'
  if (type.includes('search')) return '🔍'
  if (type.includes('deviation')) return '⚠️'
  return '•'
}

/**
 * The workspace's right rail — a focused "AI Collaboration" surface: the current
 * task, live phase/tool, run controls, and a scrolling activity log. Mirrors the
 * reference IDE's collaboration panel, wired to the real collaboration state and
 * pause/resume/stop mutations.
 */
export function AICollabPanel({ workspaceId, mission }: { workspaceId: string; mission?: MissionPhase }) {
  const toast = useToast()
  const dispatch = useAppDispatch()
  const collab = useAppSelector((s) => s.workspaceActivity.collaboration)
  const reduxTransitional = useAppSelector((s) => s.workspaceActivity.transitionalAction)
  const events = useAppSelector((s) => s.workspaceActivity.aiEvents)
  const [pause, { isLoading: pausing }] = usePauseExecutionMutation()
  const [resume, { isLoading: resuming }] = useResumeExecutionMutation()
  const [stop, { isLoading: stopping }] = useStopExecutionMutation()

  // ── Transitional state management (Task 9.1) ─────────────────────────────
  type TransitionalState = 'pausing' | 'stopping' | 'resuming' | null
  const [transitional, setTransitional] = useState<TransitionalState>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastActionTimestampRef = useRef<number>(0)

  // Merge local transitional state with Redux transitional action from multi-tab events
  const effectiveTransitional: TransitionalState = transitional ?? reduxTransitional

  // Clear transitional state when authoritative status confirms it (Task 9.2)
  const status = collab.status
  useEffect(() => {
    if (!effectiveTransitional) return
    const confirmed =
      (effectiveTransitional === 'pausing' && status === 'paused') ||
      (effectiveTransitional === 'stopping' && (status === 'stopped' || status === 'completed')) ||
      (effectiveTransitional === 'resuming' && status === 'running')
    if (confirmed) {
      setTransitional(null)
      dispatch(transitionalActionSet(null))
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [status, effectiveTransitional, dispatch])

  // Also clear local transitional when Redux clears it (e.g. reconnection)
  useEffect(() => {
    if (reduxTransitional === null && transitional !== null) {
      // Only clear if Redux explicitly cleared (reconnection recovery)
      // We need to check if the authoritative status matches
      const statusConfirms =
        (transitional === 'pausing' && status === 'paused') ||
        (transitional === 'stopping' && (status === 'stopped' || status === 'completed')) ||
        (transitional === 'resuming' && status === 'running')
      if (statusConfirms) {
        setTransitional(null)
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
      }
    }
  }, [reduxTransitional, transitional, status])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  // Safety-net timeouts, per action. Stop/Resume act on the pipeline within ~1s,
  // so a short window catches a genuinely lost confirmation. Pause is a *soft,
  // between-steps* signal — the request already succeeded server-side and the
  // hold only happens once the current step finishes, which can legitimately take
  // a while (a long agent step or build). A short timeout there would fire a false
  // "timed out" error while the pause is still correctly pending, so it gets a
  // much longer window.
  const TRANSITION_TIMEOUT_MS: Record<'pausing' | 'stopping' | 'resuming', number> = {
    pausing: 180000,
    resuming: 20000,
    stopping: 20000,
  }

  const startTransition = (action: 'pausing' | 'stopping' | 'resuming') => {
    const now = Date.now()
    // Task 9.4: Rapid successive actions (<2s) — last action wins, reset timeout
    lastActionTimestampRef.current = now

    setTransitional(action)
    dispatch(transitionalActionSet(action))

    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      // Task 9.2: Timeout recovery — revert to authoritative state and show error
      setTransitional(null)
      dispatch(transitionalActionSet(null))
      timeoutRef.current = null
      toast.error('Control action timed out — please retry')
    }, TRANSITION_TIMEOUT_MS[action])
  }

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  const usePhase = Boolean(mission?.available)

  // ── Run controls ──────────────────────────────────────────────────────────
  // The collaboration WebSocket status is the authoritative source for whether
  // controls should be enabled. It reflects ALL pipeline phases (execution,
  // validation, repair, publishing), not just the execution phase.
  const collabStatus = collab.status
  const execRunning = collabStatus === 'running'
  const execPaused = collabStatus === 'paused'

  // Optimistic bridge for the gap between a click and the next poll.
  const [optimisticPaused, setOptimisticPaused] = useState<boolean | null>(null)

  const controllable = execRunning || execPaused || (optimisticPaused !== null)
  const paused =
    optimisticPaused !== null ? optimisticPaused : execPaused ? true : execRunning ? false : false
  const active = controllable
  const running = controllable && !paused

  // Task 9.5: While in transitional state, disable all control buttons
  const inTransition = effectiveTransitional !== null

  // Clear the optimistic guess once the real status confirms/ends the run.
  useEffect(() => {
    if (optimisticPaused === null) return
    if (execPaused === optimisticPaused || (!execRunning && !execPaused)) {
      setOptimisticPaused(null)
    }
  }, [execPaused, execRunning, optimisticPaused])

  const currentTask = usePhase ? (mission?.intent ?? 'Mission') : (collab.label ?? STATUS_LABEL[status] ?? 'Idle')
  const phaseLabel = usePhase ? (mission?.label ?? 'Idle') : (STATUS_LABEL[status] ?? 'Idle')
  const phaseLive = usePhase ? Boolean(mission?.live) : active
  const progressPct = usePhase ? Math.round((mission?.progress ?? 0) * 100) : status === 'completed' ? 100 : 0

  // Show transitional text in progress state when applicable
  const progressState = effectiveTransitional
    ? (effectiveTransitional === 'pausing' ? 'Pausing...' : effectiveTransitional === 'stopping' ? 'Stopping...' : 'Resuming...')
    : usePhase
      ? (mission?.live ? 'In progress' : phaseLabel)
      : running ? 'Working' : paused ? 'Paused' : STATUS_LABEL[status] ?? 'Idle'

  const lastTool = [...events].reverse().find((e) => e.type.includes('tool_call'))
  const lastEvent = events[events.length - 1]

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      if (ok) toast.success(ok)
    } catch {
      toast.error('Action failed')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-9 flex-shrink-0 items-center border-b border-line-subtle bg-surface px-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
          <Icon name="sparkles" size={15} className="text-primary" /> AI Collaboration
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Current task */}
        <div className="flex flex-col gap-1.5">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Current Task</div>
          <div className="text-[13px] text-fg">{currentTask}</div>
        </div>

        {/* Phase / tool */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-card p-2.5">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Phase</div>
            <div className={cn('text-[13px]', phaseLive ? 'text-primary' : 'text-fg-muted')}>{phaseLabel}</div>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-card p-2.5">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Tool</div>
            <div className="truncate text-[13px] text-fg-muted">{lastTool?.label ?? '—'}</div>
          </div>
        </div>

        {/* Progress */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Progress</span>
            <span className="font-mono text-[11px] text-fg-subtle">
              {effectiveTransitional
                ? (effectiveTransitional === 'pausing' ? 'Pausing…' : effectiveTransitional === 'stopping' ? 'Stopping…' : 'Resuming…')
                : usePhase ? `${progressPct}%` : progressState}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn('h-full rounded-full bg-primary transition-all', !usePhase && running && 'w-1/3 animate-pulse')}
              style={usePhase || !running ? { width: `${progressPct}%` } : undefined}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="flex gap-2">
          {inTransition ? (
            <>
              {effectiveTransitional === 'pausing' && (
                <Button variant="secondary" disabled loading leadingIcon={<Icon name="pause" size={14} />}>Pausing…</Button>
              )}
              {effectiveTransitional === 'resuming' && (
                <Button variant="primary" disabled loading leadingIcon={<Icon name="play" size={14} />}>Resuming…</Button>
              )}
              {effectiveTransitional === 'stopping' && (
                <Button variant="danger" disabled loading leadingIcon={<Icon name="stop" size={13} />}>Stopping…</Button>
              )}
              {effectiveTransitional !== 'stopping' && (
                <Button variant="danger" disabled leadingIcon={<Icon name="stop" size={13} />}>Stop</Button>
              )}
            </>
          ) : (
            <>
              {paused ? (
                <Button variant="primary" loading={resuming} disabled={!controllable}
                  leadingIcon={<Icon name="play" size={14} />}
                  onClick={() => {
                    startTransition('resuming')
                    run(async () => { await resume(workspaceId).unwrap(); setOptimisticPaused(false) }, '')
                  }}>
                  Resume
                </Button>
              ) : (
                <Button variant="secondary" loading={pausing} disabled={!controllable}
                  leadingIcon={<Icon name="pause" size={14} />}
                  onClick={() => {
                    startTransition('pausing')
                    run(async () => { await pause(workspaceId).unwrap(); setOptimisticPaused(true) }, '')
                  }}>
                  Pause
                </Button>
              )}
              <Button variant="danger" loading={stopping} disabled={!active}
                leadingIcon={<Icon name="stop" size={13} />}
                onClick={() => {
                  startTransition('stopping')
                  run(async () => { await stop(workspaceId).unwrap(); setOptimisticPaused(null) }, '')
                }}>
                Stop
              </Button>
            </>
          )}
        </div>
        {inTransition ? (
          <div className="text-[11px] leading-relaxed text-fg-subtle">
            {effectiveTransitional === 'pausing'
              ? 'Finishing the current step, then execution will hold. Resume continues from here.'
              : effectiveTransitional === 'resuming'
                ? 'Resuming — continuing from where it paused.'
                : 'Stopping — cancelling the current run.'}
          </div>
        ) : !controllable ? (
          <div className="text-[11px] leading-relaxed text-fg-subtle">
            {usePhase && mission?.live
              ? `${mission.label} in progress — pause & stop apply during execution`
              : 'No active run to control.'}
          </div>
        ) : null}

        {/* Activity log */}
        <div className="flex flex-col gap-1.5">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Activity Log</div>
          {events.length === 0 ? (
            <div className="text-xs text-fg-subtle">Live reasoning and tool calls appear here.</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {events.map((e) => {
                const isLast = e.id === lastEvent?.id
                return (
                  <div key={e.id} className={cn('flex items-center gap-2 rounded-md px-2 py-1', isLast && active ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
                    <span className="flex-shrink-0 text-sm leading-none">{glyph(e.type)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{e.label}</span>
                  </div>
                )
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
