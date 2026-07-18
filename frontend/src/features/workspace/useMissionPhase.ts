import { useGetTaskQuery } from '@/services/api/taskApi'
import { useGetExecutionQuery } from '@/services/api/executionApi'
import { useGetValidationQuery } from '@/services/api/validationApi'

export type PhaseTone = 'active' | 'success' | 'danger' | 'neutral'

export interface MissionPhase {
  /** True only when we have the repo context needed to resolve the phase. */
  available: boolean
  /** The mission's request line — used as the panel's "Current Task". */
  intent?: string
  /** Human phase label: Planning / Executing / Validating / … */
  label: string
  /** A phase is actively streaming. */
  live: boolean
  /** Execution is running/pending — the agent loop is interruptible (pause/stop). */
  execLive: boolean
  /** Raw execution status (pending/running/paused/completed/cancelled/failed…) — the
   *  authoritative source for the pause/resume/stop controls. */
  execStatus?: string
  tone: PhaseTone
  /** 0..1 position through the pipeline (honest ordering, not an ETA). */
  progress: number
}

const EXEC_LIVE = new Set(['pending', 'running'])

/**
 * Resolves the *mission's* current phase from the same sources the mission page
 * uses (task + execution + validation), so the IDE mirrors it instead of only
 * reflecting the interactive agent's collaboration status. Falls back to
 * `available: false` when no repo context is present in the URL.
 */
export function useMissionPhase(repoId: string, taskId: string): MissionPhase {
  const enabled = Boolean(repoId && taskId)

  const { data: taskData } = useGetTaskQuery(
    { repoId, taskId },
    { skip: !enabled, pollingInterval: 5000 },
  )
  const { data: execSnap } = useGetExecutionQuery(
    { repoId, taskId },
    { skip: !enabled, pollingInterval: 5000 },
  )
  const { data: valSnap } = useGetValidationQuery(
    { repoId, taskId },
    { skip: !enabled, pollingInterval: 5000 },
  )

  if (!enabled) {
    return { available: false, label: 'Idle', live: false, execLive: false, execStatus: undefined, tone: 'neutral', progress: 0 }
  }

  const task = taskData?.task
  const status = task?.status ?? ''
  const execStatus = execSnap?.execution?.status
  const valStatus = valSnap?.run?.status
  const overall = valSnap?.run?.overall_result

  const isPlanningLive = status === 'planning' || status === 'draft'
  const isExecuting = EXEC_LIVE.has(execStatus ?? '')
  const execDone = execStatus === 'completed'
  const valLive = valStatus === 'running' || valStatus === 'pending'
  const repairing = status === 'repairing'
  const publishing = status === 'publishing'
  const missionDone = status === 'done' || overall === 'passed'
  const missionFailed = status === 'failed' || status === 'cancelled'

  const live = isPlanningLive || isExecuting || valLive || repairing || publishing

  const label = isPlanningLive
    ? 'Planning'
    : status === 'plan_ready'
      ? 'Plan review'
      : isExecuting
        ? 'Executing'
        : valLive
          ? 'Validating'
          : repairing
            ? 'Repairing'
            : publishing
              ? 'Publishing'
              : missionDone
                ? 'Completed'
                : missionFailed
                  ? (status === 'cancelled' ? 'Cancelled' : 'Failed')
                  : execDone
                    ? 'Executed'
                    : status === 'plan_approved'
                      ? 'Approved'
                      : 'Idle'

  const tone: PhaseTone = missionFailed ? 'danger' : missionDone ? 'success' : live ? 'active' : 'neutral'

  const progress = missionFailed || missionDone
    ? 1
    : publishing
      ? 0.92
      : repairing
        ? 0.85
        : valLive
          ? 0.78
          : execDone
            ? 0.66
            : isExecuting
              ? 0.55
              : status === 'plan_approved'
                ? 0.34
                : status === 'plan_ready'
                  ? 0.22
                  : isPlanningLive
                    ? 0.12
                    : 0.05

  return { available: true, intent: task?.intent, label, live, execLive: isExecuting, execStatus, tone, progress }
}
