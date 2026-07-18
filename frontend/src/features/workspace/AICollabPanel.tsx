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
import styles from './AICollabPanel.module.css'

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
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.headTitle}>
          <Icon name="sparkles" size={15} /> AI Collaboration
        </span>
      </div>

      <div className={styles.scroll}>
        {/* Current task */}
        <div className={styles.section}>
          <div className={styles.label}>Current Task</div>
          <div className={styles.task}>{currentTask}</div>
        </div>

        {/* Phase / tool */}
        <div className={styles.grid}>
          <div className={styles.metaCard}>
            <div className={styles.label}>Phase</div>
            <div className={`${styles.metaValue} ${phaseLive ? styles.metaActive : ''}`}>
              {phaseLabel}
            </div>
          </div>
          <div className={styles.metaCard}>
            <div className={styles.label}>Tool</div>
            <div className={styles.metaValue}>{lastTool?.label ?? '—'}</div>
          </div>
        </div>

        {/* Progress — pipeline position when known, else indeterminate while running */}
        <div className={styles.section}>
          <div className={styles.progressHead}>
            <span className={styles.label}>Progress</span>
            <span className={styles.progressState}>
              {/* A pending control action takes priority over the phase %, so the
                  user always sees their request is being honored. */}
              {effectiveTransitional
                ? (effectiveTransitional === 'pausing' ? 'Pausing…' : effectiveTransitional === 'stopping' ? 'Stopping…' : 'Resuming…')
                : usePhase ? `${progressPct}%` : progressState}
            </span>
          </div>
          <div className={styles.track}>
            <div
              className={`${styles.bar} ${!usePhase && running ? styles.barIndeterminate : ''}`}
              style={usePhase || !running ? { width: `${progressPct}%` } : undefined}
            />
          </div>
        </div>

        {/* Controls — always visible; enabled while a run is interruptible. */}
        <div className={styles.controls}>
          {/* Task 9.5: Button state logic based on transitional and authoritative states */}
          {inTransition ? (
            <>
              {effectiveTransitional === 'pausing' && (
                <Button variant="secondary" disabled loading
                  leadingIcon={<Icon name="pause" size={14} />}>
                  Pausing…
                </Button>
              )}
              {effectiveTransitional === 'resuming' && (
                <Button variant="primary" disabled loading
                  leadingIcon={<Icon name="play" size={14} />}>
                  Resuming…
                </Button>
              )}
              {effectiveTransitional === 'stopping' && (
                <Button variant="danger" disabled loading
                  leadingIcon={<Icon name="stop" size={13} />}>
                  Stopping…
                </Button>
              )}
              {/* Show disabled counterpart buttons during transition */}
              {effectiveTransitional !== 'stopping' && (
                <Button variant="danger" disabled
                  leadingIcon={<Icon name="stop" size={13} />}>
                  Stop
                </Button>
              )}
            </>
          ) : (
            <>
              {paused ? (
                <Button variant="primary" loading={resuming} disabled={!controllable}
                  leadingIcon={<Icon name="play" size={14} />}
                  onClick={() => {
                    startTransition('resuming')
                    run(
                      async () => { await resume(workspaceId).unwrap(); setOptimisticPaused(false) },
                      '',
                    )
                  }}>
                  Resume
                </Button>
              ) : (
                <Button variant="secondary" loading={pausing} disabled={!controllable}
                  leadingIcon={<Icon name="pause" size={14} />}
                  onClick={() => {
                    startTransition('pausing')
                    run(
                      async () => { await pause(workspaceId).unwrap(); setOptimisticPaused(true) },
                      '',
                    )
                  }}>
                  Pause
                </Button>
              )}
              <Button variant="danger" loading={stopping} disabled={!active}
                leadingIcon={<Icon name="stop" size={13} />}
                onClick={() => {
                  startTransition('stopping')
                  run(
                    async () => { await stop(workspaceId).unwrap(); setOptimisticPaused(null) },
                    '',
                  )
                }}>
                Stop
              </Button>
            </>
          )}
        </div>
        {inTransition ? (
          <div className={styles.controlHint}>
            {effectiveTransitional === 'pausing'
              ? 'Finishing the current step, then execution will hold. Resume continues from here.'
              : effectiveTransitional === 'resuming'
                ? 'Resuming — continuing from where it paused.'
                : 'Stopping — cancelling the current run.'}
          </div>
        ) : !controllable ? (
          <div className={styles.controlHint}>
            {usePhase && mission?.live
              ? `${mission.label} in progress — pause & stop apply during execution`
              : 'No active run to control.'}
          </div>
        ) : null}

        {/* Activity log */}
        <div className={styles.section}>
          <div className={styles.label}>Activity Log</div>
          {events.length === 0 ? (
            <div className={styles.empty}>Live reasoning and tool calls appear here.</div>
          ) : (
            <div className={styles.log}>
              {events.map((e) => {
                const isLast = e.id === lastEvent?.id
                return (
                  <div key={e.id} className={`${styles.logRow} ${isLast && active ? styles.logRowLive : ''}`}>
                    <span className={styles.logGlyph}>{glyph(e.type)}</span>
                    <span className={styles.logLabel}>{e.label}</span>
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
