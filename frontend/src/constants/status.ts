/**
 * Status → visual tone mappings. Tones resolve to the status ramp in tokens.css
 * via the Badge component. Keeping these declarative means new backend statuses
 * degrade gracefully to 'neutral' instead of throwing.
 */

export type Tone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'accent'

export interface StatusMeta {
  tone: Tone
  label: string
}

function meta(tone: Tone, label: string): StatusMeta {
  return { tone, label }
}

export const WORK_ITEM_STATUS: Record<string, StatusMeta> = {
  draft: meta('neutral', 'Draft'),
  planning: meta('info', 'Planning'),
  planning_failed: meta('danger', 'Planning failed'),
  plan_ready: meta('warning', 'Plan ready'),
  plan_approved: meta('success', 'Approved'),
  executing: meta('info', 'Executing'),
  done: meta('success', 'Done'),
  failed: meta('danger', 'Failed'),
  cancelled: meta('neutral', 'Cancelled'),
}

export const APPROVAL_STATUS: Record<string, StatusMeta> = {
  pending: meta('warning', 'Pending review'),
  approved: meta('success', 'Approved'),
  rejected: meta('danger', 'Rejected'),
}

export const EXECUTION_STATUS: Record<string, StatusMeta> = {
  pending: meta('neutral', 'Pending'),
  running: meta('info', 'Running'),
  completed: meta('success', 'Completed'),
  failed: meta('danger', 'Failed'),
  cancelled: meta('neutral', 'Cancelled'),
}

export const STEP_STATUS: Record<string, StatusMeta> = {
  pending: meta('neutral', 'Pending'),
  running: meta('info', 'Running'),
  completed: meta('success', 'Completed'),
  failed: meta('danger', 'Failed'),
  skipped: meta('neutral', 'Skipped'),
  deviated: meta('warning', 'Deviated'),
}

export const INDEX_JOB_STATUS: Record<string, StatusMeta> = {
  queued: meta('warning', 'Queued'),
  running: meta('info', 'Indexing'),
  done: meta('success', 'Indexed'),
  failed: meta('danger', 'Failed'),
  superseded: meta('neutral', 'Superseded'),
}

export const WORKSPACE_STATUS: Record<string, StatusMeta> = {
  provisioning: meta('info', 'Provisioning'),
  ready: meta('success', 'Ready'),
  executing: meta('info', 'Executing'),
  completed: meta('success', 'Completed'),
  failed: meta('danger', 'Failed'),
  timed_out: meta('danger', 'Timed out'),
  killed: meta('danger', 'Killed'),
  destroying: meta('warning', 'Destroying'),
  destroyed: meta('neutral', 'Destroyed'),
}

export const RISK_LEVEL: Record<string, StatusMeta> = {
  low: meta('success', 'Low'),
  medium: meta('warning', 'Medium'),
  high: meta('danger', 'High'),
}

export function resolveStatus(
  map: Record<string, StatusMeta>,
  key: string | undefined | null,
): StatusMeta {
  if (!key) return meta('neutral', 'Unknown')
  return map[key] ?? meta('neutral', key)
}
