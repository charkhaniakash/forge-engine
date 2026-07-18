import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from '@/components/common'
import { useAppSelector } from '@/app/hooks'
import {
  usePauseExecutionMutation,
  useResumeExecutionMutation,
  useStopExecutionMutation,
} from '@/services/api/workspaceEditorApi'
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
  const collab = useAppSelector((s) => s.workspaceActivity.collaboration)
  const events = useAppSelector((s) => s.workspaceActivity.aiEvents)
  const [pause, { isLoading: pausing }] = usePauseExecutionMutation()
  const [resume, { isLoading: resuming }] = useResumeExecutionMutation()
  const [stop, { isLoading: stopping }] = useStopExecutionMutation()

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  const status = collab.status
  const usePhase = Boolean(mission?.available)

  // ── Run controls ──────────────────────────────────────────────────────────
  // The pause/resume/stop endpoints act ONLY on the execution orchestrator, and
  // only while it's actively looping (between steps). So the controls are driven
  // by the authoritative, polled *execution* status — never by the stale
  // `collaboration` socket channel, which can get stuck at "running" from an
  // earlier phase and would otherwise let the buttons lie during validation.
  const execStatus = usePhase ? mission?.execStatus : status
  const execRunning = execStatus === 'running' || execStatus === 'pending'
  const execPaused = execStatus === 'paused'

  // Optimistic bridge for the gap between a click and the next poll. Reconciled
  // against the real status the moment it arrives.
  const [optimisticPaused, setOptimisticPaused] = useState<boolean | null>(null)

  const controllable = execRunning || execPaused || (optimisticPaused !== null)
  // The optimistic guess wins until the poll reconciles it, so the Pause⇄Resume
  // swap is instant instead of waiting up to a poll interval.
  const paused =
    optimisticPaused !== null ? optimisticPaused : execPaused ? true : execRunning ? false : false
  const active = controllable
  const running = controllable && !paused

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
  const progressState = usePhase
    ? (mission?.live ? 'In progress' : phaseLabel)
    : running ? 'Working' : paused ? 'Paused' : STATUS_LABEL[status] ?? 'Idle'

  const lastTool = [...events].reverse().find((e) => e.type.includes('tool_call'))
  const lastEvent = events[events.length - 1]

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast.success(ok)
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
              {usePhase ? `${progressPct}%` : progressState}
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
          {paused ? (
            <Button variant="primary" loading={resuming} disabled={!controllable}
              leadingIcon={<Icon name="play" size={14} />}
              onClick={() => run(
                async () => { await resume(workspaceId).unwrap(); setOptimisticPaused(false) },
                'Resumed',
              )}>
              Resume
            </Button>
          ) : (
            <Button variant="secondary" loading={pausing} disabled={!controllable}
              leadingIcon={<Icon name="pause" size={14} />}
              onClick={() => run(
                async () => { await pause(workspaceId).unwrap(); setOptimisticPaused(true) },
                'Paused',
              )}>
              Pause
            </Button>
          )}
          <Button variant="danger" loading={stopping} disabled={!active}
            leadingIcon={<Icon name="stop" size={13} />}
            onClick={() => run(
              async () => { await stop(workspaceId).unwrap(); setOptimisticPaused(null) },
              'Stopped',
            )}>
            Stop
          </Button>
        </div>
        {!controllable && (
          <div className={styles.controlHint}>
            {usePhase && mission?.live
              ? `${mission.label} in progress — pause & stop apply during execution`
              : 'No active run to control.'}
          </div>
        )}

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
