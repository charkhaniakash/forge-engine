/**
 * Plan mode — whether Forge stops at plan_ready for review, or auto-runs.
 *
 *   "Plan" ON  → review the plan before it runs (default).
 *   "Plan" OFF → auto-run: once the plan is ready, approve + provision + execute
 *                automatically, so the user isn't gated on a review each time.
 *
 * The preference is global + persisted. The per-task flag records that a
 * specific task should auto-run when its plan becomes ready, and survives a
 * page refresh (the pipeline is client-orchestrated, so the mission page reads
 * this flag to decide whether to auto-approve+run on plan_ready).
 */
const PLAN_MODE_KEY = 'forge_plan_mode'

export function loadPlanMode(): boolean {
  try {
    return localStorage.getItem(PLAN_MODE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function savePlanMode(on: boolean): void {
  try {
    localStorage.setItem(PLAN_MODE_KEY, on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}

const autoRunKey = (taskId: string) => `forge_autorun_${taskId}`

export function markAutoRun(taskId: string): void {
  try {
    localStorage.setItem(autoRunKey(taskId), '1')
  } catch {
    /* ignore */
  }
}

export function isAutoRun(taskId: string): boolean {
  try {
    return localStorage.getItem(autoRunKey(taskId)) === '1'
  } catch {
    return false
  }
}

export function clearAutoRun(taskId: string): void {
  try {
    localStorage.removeItem(autoRunKey(taskId))
  } catch {
    /* ignore */
  }
}
