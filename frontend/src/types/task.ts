import type { ID, ISODate, RiskLevel } from './common'

export type WorkItemStatus =
  | 'draft'
  | 'planning'
  | 'planning_failed'
  | 'plan_ready'
  | 'plan_approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface WorkItem {
  id: ID
  repo_id: ID
  intent: string
  status: WorkItemStatus | string
  approval_status: ApprovalStatus | string
  error?: string
  created_at: ISODate
}

export type PlanStepType = 'edit' | 'test' | 'verify' | 'manual'

export interface PlanStep {
  id: ID
  stable_id: string
  order: number
  depends_on: string[]
  title: string
  description: string
  type: PlanStepType
  affected_files: string[]
  estimated_risk: RiskLevel
  user_edited: boolean
  metadata: Record<string, unknown>
}

export interface PlanRisk {
  severity: string
  description: string
}

export interface PlanAssumption {
  description: string
  user_verified: boolean
}

export interface PlanAffectedFile {
  path: string
  change_type: string
  rationale: string
}

export interface PlanBody {
  schema_version: string
  plan_type: string
  intent_summary: string
  risks: PlanRisk[]
  assumptions: PlanAssumption[]
  affected_files: PlanAffectedFile[]
  steps: PlanStep[]
}

export interface Plan {
  id: ID
  work_item_id: ID
  version: number
  plan_type: string
  planner_id: string
  body: PlanBody
  is_active: boolean
  created_by: string
  created_at: ISODate
}

export interface CreateTaskRequest {
  intent: string
}

export interface MissionMessage {
  id: string
  work_item_id: string
  role: 'user' | 'assistant'
  content: string
  turn_number: number
  created_at: string
}
