import { Icon, StatusBadge, Button } from '@/components/common'
import { MissionThread } from '@/features/task-workspace/MissionThread'
import type { ConversationEntry } from '@/features/task-workspace/model'
import { WORK_ITEM_STATUS } from '@/constants/status'

const now = Date.now()

const mockPlan = {
  id: 'plan-1',
  work_item_id: 'wi-1',
  version: 1,
  plan_type: 'implementation',
  planner_id: 'p1',
  is_active: true,
  created_by: 'agent',
  created_at: new Date(now).toISOString(),
  body: {
    schema_version: '1',
    plan_type: 'implementation',
    intent_summary: 'Fix the TooltipProvider crash and the two typo bugs breaking the build.',
    risks: [],
    assumptions: [],
    affected_files: [
      { path: 'src/App.tsx', change_type: 'modify', rationale: 'add missing import' },
      { path: 'src/Addsongs.js', change_type: 'modify', rationale: 'fix typos' },
    ],
    steps: [
      { id: 's1', stable_id: 's1', order: 0, depends_on: [], title: 'Add missing TooltipProvider import', description: 'App.tsx uses useState without importing it', type: 'edit', affected_files: ['src/App.tsx'], estimated_risk: 'low', user_edited: false, metadata: {} },
      { id: 's2', stable_id: 's2', order: 1, depends_on: [], title: 'Fix typo bugs in Addsongs.js', description: 'useNavgate -> useNavigate, uncomment axios import', type: 'edit', affected_files: ['src/Addsongs.js'], estimated_risk: 'low', user_edited: false, metadata: {} },
    ],
  },
}

const entries: ConversationEntry[] = [
  { type: 'intent', text: 'i am facing issue in the Toptenart please fix' },
  {
    type: 'work',
    isLive: false,
    group: {
      id: 'g1',
      hasToolActivity: false,
      durationMs: 3000,
      events: [
        { id: 'e1', seq: 0, phase: 'planning', kind: 'reasoning', title: 'Looking into the Toptenart issue now', tone: 'neutral', atMs: now - 3000 },
        { id: 'e2', seq: 1, phase: 'planning', kind: 'reasoning', title: 'Checking App.tsx for the crash source', tone: 'neutral', atMs: now - 1000 },
      ],
    },
  },
  { type: 'plan', plan: mockPlan as never },
  {
    type: 'work',
    isLive: false,
    group: {
      id: 'g2',
      hasToolActivity: true,
      durationMs: 129000,
      events: [
        { id: 'e3', seq: 2, phase: 'executing', kind: 'reasoning', title: 'The component used useState without importing it', tone: 'neutral', atMs: now - 129000 },
        { id: 'e4', seq: 3, phase: 'executing', kind: 'tool_call', tool: 'write_file', title: 'Writing src/App.tsx', tone: 'info', atMs: now - 100000 },
        { id: 'e5', seq: 4, phase: 'executing', kind: 'tool_result', tool: 'write_file', title: 'write_file', tone: 'success', outcome: 'ok', atMs: now - 90000 },
      ],
    },
  },
  { type: 'message', event: { id: 'm1', seq: 5, phase: 'executing', kind: 'status', title: 'Step complete: added missing import', tone: 'success', atMs: now - 80000 } },
  {
    type: 'files',
    files: [
      { path: 'src/App.tsx', operation: 'modify', linesAdded: 1, linesRemoved: 0 },
      { path: 'src/Addsongs.js', operation: 'modify', linesAdded: 2, linesRemoved: 2 },
    ],
  },
  {
    type: 'validation',
    overall: 'passed',
    stages: [
      { name: 'build', state: 'passed', log: [], durationMs: 1200 },
      { name: 'test', state: 'passed', log: [], durationMs: 800 },
    ],
  },
  {
    type: 'publish',
    session: {
      id: 'pub-1',
      work_item_id: 'wi-1',
      task_execution_id: 'exec-1',
      workspace_id: 'ws-1',
      status: 'completed',
      current_step: null,
      branch_name: 'forge/fix-toptenart-crash',
      pr_number: 1,
      pr_url: 'https://github.com/charkhaniakash/Delta_X/pull/1',
      draft_mode: false,
      error_message: null,
      started_at: null,
      completed_at: null,
      created_at: new Date(now).toISOString(),
    },
  },
]

const header = (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 24px' }}>
    <button style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 3 }}>
      <Icon name="chevronLeft" size={14} /> Missions
    </button>
    <h1 style={{ flex: 1, fontSize: 14, fontWeight: 500, margin: 0 }}>Fix Toptenart issue</h1>
    <StatusBadge map={WORK_ITEM_STATUS} status="done" size="sm" />
    <a href="#" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--success-subtle)', color: 'var(--success)', borderRadius: 999, padding: '3px 12px', fontSize: 12, textDecoration: 'none' }}>
      <Icon name="git" size={13} /> #1
    </a>
  </div>
)

/** Scratch harness to visually verify MissionThread — not part of the app, delete after review. */
export default function MissionThreadPreview() {
  return (
    <div style={{ height: '100vh', width: '100%' }}>
      <MissionThread
        header={header}
        entries={entries}
        live={false}
        planActions={<>
          <Button variant="ghost">Edit / Re-plan</Button>
          <Button variant="danger">Reject</Button>
          <Button variant="primary">Approve &amp; run</Button>
        </>}
        actionRow={null}
      />
    </div>
  )
}
