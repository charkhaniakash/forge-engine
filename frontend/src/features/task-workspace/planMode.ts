/**
 * Plan mode — a UI preference for the default state of the "Plan" toggle.
 *
 *   "Plan" ON  → review the plan before it runs (default).
 *   "Plan" OFF → auto-run: skip the review gate and run when the plan is ready.
 *
 * This only remembers the toggle's *default* across sessions. The actual auto-run
 * decision is sent to the backend (createTask / follow-up `auto_run`) and stored
 * there — the server is the source of truth and drives the whole sequence, so
 * behavior never depends on client state.
 */
const PLAN_MODE_KEY = 'forge_plan_mode'

export function loadPlanMode(): boolean {
  try {
    const val = localStorage.getItem(PLAN_MODE_KEY)
    if (val === null) return false
    return val !== 'off'
  } catch {
    return false
  }
}

export function savePlanMode(on: boolean): void {
  try {
    localStorage.setItem(PLAN_MODE_KEY, on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}
