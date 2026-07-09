/**
 * Pure mappers: backend entities + live socket events → workspace view models.
 * Kept side-effect free so they're trivially testable and the container stays
 * thin. Nothing here renders raw DB rows — it all becomes lifecycle phases, a
 * unified activity feed, validation stages, repair attempts, and file changes.
 */
import type { Tone } from '@/constants/status'
import type {
  CodeDiff,
  ExecutionSnapshot,
  PlanningSocketEvent,
  StepExecution,
  ValidationRun,
  ValidationStage,
  WorkItem,
} from '@/types'
import type { RepairSession, RepairSocketEvent } from '@/types/repair'
import type { ExecutionLiveEvent, ValidationLiveEvent } from '@/store/slices/streamSlice'
import type {
  ActivityEvent,
  FileChangeVM,
  LifecyclePhase,
  PhaseState,
  RepairAttemptVM,
  ValidationStageVM,
} from './model'

const OUTCOME_TONE: Record<string, Tone> = {
  passed: 'success',
  improved: 'success',
  no_change: 'warning',
  regressed: 'danger',
  cannot_repair: 'danger',
}

function argStr(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key]
  return typeof v === 'string' ? v : undefined
}

function humanizeTool(tool: string | undefined, args?: Record<string, unknown>): string {
  const t = (tool ?? 'tool').toLowerCase()
  const path = argStr(args, 'path') ?? argStr(args, 'file_path')
  const query = argStr(args, 'query') ?? argStr(args, 'symbol') ?? argStr(args, 'pattern')
  if (t.includes('read')) return `Reading ${path ?? 'file'}`
  if (t.includes('write') || t.includes('edit')) return `Writing ${path ?? 'file'}`
  if (t.includes('create')) return `Creating ${path ?? 'file'}`
  if (t.includes('delete') || t.includes('remove')) return `Deleting ${path ?? 'file'}`
  if (t.includes('search') || t.includes('symbol') || t.includes('grep')) return `Searching ${query ?? ''}`.trim()
  if (t.includes('list') || t.includes('dir')) return `Listing ${path ?? '.'}`
  return tool ?? 'Tool call'
}

// ── Activity feed ─────────────────────────────────────────────────────────────

interface ActivityInputs {
  planning: PlanningSocketEvent[]
  execution: ExecutionLiveEvent[]
  validation: ValidationLiveEvent[]
  repair: RepairSocketEvent[]
}

export function buildActivity({ planning, execution, validation, repair }: ActivityInputs): ActivityEvent[] {
  const out: ActivityEvent[] = []
  let seq = 0
  const push = (e: Omit<ActivityEvent, 'seq' | 'id'>) => {
    out.push({ ...e, seq, id: `${e.phase}-${seq}-${e.kind}` })
    seq += 1
  }

  for (const ev of planning) {
    const msg = typeof ev.message === 'string' ? ev.message : ''
    const stage = typeof ev.stage === 'string' ? ev.stage : undefined
    if (!msg && !stage) continue
    push({
      phase: 'planning',
      kind: ev.event === 'error' ? 'error' : 'reasoning',
      title: msg || String(ev.event),
      detail: stage,
      tone: ev.event === 'error' ? 'danger' : 'neutral',
    })
  }

  for (const le of execution) {
    const ev = le.raw
    switch (ev.event) {
      case 'reasoning':
        push({ phase: 'executing', kind: 'reasoning', title: String(ev.message ?? ''), tone: 'neutral' })
        break
      case 'tool_call':
        push({
          phase: 'executing',
          kind: 'tool_call',
          tool: ev.tool,
          title: humanizeTool(ev.tool, ev.args),
          tone: 'info',
        })
        break
      case 'tool_result':
        push({
          phase: 'executing',
          kind: 'tool_result',
          tool: ev.tool,
          title: ev.tool ?? 'result',
          tone: ev.success ? 'success' : 'danger',
          outcome: ev.success ? 'ok' : 'fail',
        })
        break
      case 'step_complete':
        push({ phase: 'executing', kind: 'status', title: `Step complete${ev.summary ? `: ${ev.summary}` : ''}`, tone: 'success' })
        break
      case 'exec_complete':
        push({ phase: 'executing', kind: 'status', title: 'Execution complete', tone: 'success' })
        break
      case 'plan_deviation':
      case 'deviation':
        push({ phase: 'executing', kind: 'status', title: `Deviation: ${ev.message ?? ''}`, tone: 'warning' })
        break
      case 'requires_human':
        push({ phase: 'executing', kind: 'status', title: `Needs human: ${ev.message ?? ''}`, tone: 'warning' })
        break
      case 'error':
      case 'execution_error':
        push({ phase: 'executing', kind: 'error', title: `Error: ${ev.message ?? ''}`, tone: 'danger' })
        break
      default:
        if (ev.message) push({ phase: 'executing', kind: 'status', title: String(ev.message), tone: 'neutral' })
    }
  }

  for (const le of validation) {
    const ev = le.raw
    switch (ev.event) {
      case 'validation_start':
        push({ phase: 'validation', kind: 'status', title: `Validation started${ev.stack ? ` · ${ev.stack}` : ''}`, tone: 'info' })
        break
      case 'stage_start':
        push({ phase: 'validation', kind: 'validation', tool: ev.stage, title: `Running ${ev.stage}`, tone: 'info', outcome: 'running' })
        break
      case 'stage_output': {
        const chunk = String(ev.chunk ?? '').trim()
        if (chunk) push({ phase: 'validation', kind: 'validation', title: chunk.slice(0, 200), tone: 'neutral' })
        break
      }
      case 'stage_complete':
        push({
          phase: 'validation',
          kind: 'validation',
          tool: ev.stage,
          title: `${ev.stage} ${ev.passed ? 'passed' : 'failed'}`,
          detail: ev.exit_code != null ? `exit ${ev.exit_code}${ev.duration_ms != null ? ` · ${ev.duration_ms}ms` : ''}` : undefined,
          tone: ev.passed ? 'success' : 'danger',
          outcome: ev.passed ? 'ok' : 'fail',
        })
        break
      case 'stage_skipped':
        push({ phase: 'validation', kind: 'status', title: `${ev.stage} skipped${ev.reason ? `: ${ev.reason}` : ''}`, tone: 'neutral' })
        break
      case 'stage_diagnostics':
        push({
          phase: 'validation',
          kind: 'validation',
          title: `${ev.stage}: ${ev.errors ?? 0} error(s), ${ev.warnings ?? 0} warning(s)`,
          tone: (ev.errors ?? 0) > 0 ? 'danger' : 'warning',
        })
        break
      case 'validation_complete':
        push({ phase: 'validation', kind: 'status', title: `Validation ${ev.overall ?? 'complete'}`, detail: `${ev.total_errors ?? 0} error(s)`, tone: ev.overall === 'passed' ? 'success' : 'warning' })
        break
      case 'error':
        push({ phase: 'validation', kind: 'error', title: 'Validation error', tone: 'danger' })
        break
    }
  }

  for (const ev of repair) {
    switch (ev.event) {
      case 'repair_started':
        push({ phase: 'repair', kind: 'repair', title: `Repair started${ev.max_attempts ? ` · up to ${ev.max_attempts} attempts` : ''}`, tone: 'warning' })
        break
      case 'attempt_started':
        push({ phase: 'repair', kind: 'repair', title: `Repair attempt ${ev.attempt_number ?? ''} started`, tone: 'info' })
        break
      case 'reasoning':
        push({ phase: 'repair', kind: 'reasoning', title: String(ev.message ?? ''), tone: 'neutral' })
        break
      case 'tool_call':
        push({
          phase: 'repair',
          kind: 'tool_call',
          tool: ev.tool,
          title: humanizeTool(ev.tool, (ev.args ?? undefined) as Record<string, unknown> | undefined),
          tone: 'info',
        })
        break
      case 'tool_result':
        push({
          phase: 'repair',
          kind: 'tool_result',
          tool: ev.tool,
          title: ev.tool ?? 'result',
          tone: ev.success ? 'success' : 'danger',
          outcome: ev.success ? 'ok' : 'fail',
        })
        break
      case 'attempt_reasoning':
        push({
          phase: 'repair',
          kind: 'repair',
          title: `Strategy: ${ev.strategy ?? 'targeted fix'}${ev.confidence != null ? ` · ${Math.round(ev.confidence * 100)}% confidence` : ''}`,
          detail: ev.summary,
          tone: 'accent',
        })
        break
      case 'attempt_complete':
        push({
          phase: 'repair',
          kind: 'repair',
          title: `Attempt ${ev.attempt_number ?? ''}: ${ev.outcome ?? 'done'}`,
          detail: ev.modified_files?.length ? `${ev.modified_files.length} file(s)` : undefined,
          tone: ev.outcome ? OUTCOME_TONE[ev.outcome] ?? 'neutral' : 'neutral',
        })
        break
      case 'repair_complete':
        push({ phase: 'repair', kind: 'status', title: `Repair complete: ${ev.final_result ?? 'passed'}`, tone: 'success' })
        break
      case 'repair_escalated':
        push({ phase: 'repair', kind: 'error', title: `Repair escalated${ev.reason ? `: ${ev.reason}` : ''}`, tone: 'danger' })
        break
    }
  }

  return out
}

// ── Validation stages ───────────────────────────────────────────────────────

const STAGE_STATE: Record<string, PhaseState> = {
  pending: 'pending',
  running: 'active',
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  error: 'failed',
}

export function buildValidationStages(
  stages: ValidationStage[],
  live: ValidationLiveEvent[],
): ValidationStageVM[] {
  // Live streaming chunks per stage, so a running stage shows output before the
  // persisted stage row lands.
  const liveLog: Record<string, string[]> = {}
  let current: string | undefined
  for (const le of live) {
    const ev = le.raw
    if (ev.event === 'stage_start' && ev.stage) current = ev.stage
    if (ev.event === 'stage_output' && current) {
      const chunk = String(ev.chunk ?? '')
      if (chunk) (liveLog[current] ??= []).push(chunk.replace(/\n$/, ''))
    }
  }

  return stages
    .slice()
    .sort((a, b) => a.sequence_number - b.sequence_number)
    .map((s) => {
      const persisted = (s.combined_output ?? s.stdout ?? '').split('\n').filter(Boolean)
      const log = persisted.length > 0 ? persisted.slice(-400) : (liveLog[s.stage] ?? [])
      return {
        name: s.stage,
        state: STAGE_STATE[s.status] ?? 'pending',
        log,
        durationMs: s.duration_ms,
        exitCode: s.exit_code,
      }
    })
}

// ── Repair attempts ───────────────────────────────────────────────────────────

export function buildRepairAttempts(
  session: RepairSession | undefined,
  events: RepairSocketEvent[],
): RepairAttemptVM[] {
  if (!session) return []
  const byAttempt = new Map<number, RepairAttemptVM>()

  const ensure = (n: number): RepairAttemptVM => {
    let a = byAttempt.get(n)
    if (!a) {
      a = { attempt: n, state: 'active', filesModified: [] }
      byAttempt.set(n, a)
    }
    return a
  }

  let currentAttempt = 0
  for (const ev of events) {
    const n = ev.attempt_number ?? ev.attempt ?? currentAttempt
    if (ev.event === 'attempt_started' && n != null) {
      currentAttempt = n
      ensure(n)
    }
    if (ev.event === 'reasoning' && n) {
      const a = ensure(n)
      // First reasoning line of an attempt reads as the root-cause statement.
      if (!a.rootCause && ev.message) a.rootCause = ev.message
    }
    if (ev.event === 'attempt_reasoning' && n) {
      const a = ensure(n)
      a.strategy = ev.strategy ?? a.strategy
      a.confidence = ev.confidence ?? a.confidence
    }
    if (ev.event === 'attempt_complete' && n) {
      const a = ensure(n)
      a.outcome = ev.outcome
      a.filesModified = ev.modified_files ?? a.filesModified
      a.state = ev.outcome && OUTCOME_TONE[ev.outcome] === 'danger' ? 'failed' : 'passed'
    }
  }

  // Fallback: session exists but no per-attempt events yet.
  if (byAttempt.size === 0 && session.attempts_used > 0) {
    for (let i = 1; i <= session.attempts_used; i += 1) ensure(i).state = 'passed'
  }
  if (byAttempt.size === 0 && session.status === 'running') ensure(1)

  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt)
}

// ── File changes ──────────────────────────────────────────────────────────────

export function buildFileChanges(diffs: CodeDiff[]): FileChangeVM[] {
  return diffs.map((d) => ({
    path: d.file_path,
    operation: d.operation,
    linesAdded: d.lines_added,
    linesRemoved: d.lines_removed,
    diff: d.diff_unified,
  }))
}

// ── Lifecycle phases ──────────────────────────────────────────────────────────

interface PhaseInputs {
  task: WorkItem
  hasPlan: boolean
  execution?: ExecutionSnapshot | null
  validation?: ValidationRun | null
  validationStages: ValidationStageVM[]
  repairSession?: RepairSession | null
  repairAttempts: RepairAttemptVM[]
}

function execState(task: WorkItem, exec?: ExecutionSnapshot | null): PhaseState {
  const s = exec?.execution?.status
  if (s === 'running' || s === 'pending') return 'active'
  if (s === 'completed') return 'passed'
  if (s === 'failed') return 'failed'
  if (s === 'cancelled') return 'skipped'
  if (task.status === 'executing') return 'active'
  if (task.status === 'done') return 'passed'
  return 'pending'
}

function validationState(run?: ValidationRun | null): PhaseState {
  if (!run) return 'pending'
  if (run.status === 'running' || run.status === 'pending') return 'active'
  if (run.overall_result === 'passed') return 'passed'
  if (run.status === 'passed') return 'passed'
  if (run.status === 'error') return 'failed'
  if (run.overall_result && run.overall_result !== 'passed') return 'failed'
  return 'active'
}

export function buildPhases(inp: PhaseInputs): LifecyclePhase[] {
  const { task, hasPlan, execution, validation, validationStages, repairSession, repairAttempts } = inp
  const phases: LifecyclePhase[] = []

  phases.push({ kind: 'created', label: 'Task created', state: 'passed' })

  // Planning
  let planning: PhaseState = 'pending'
  if (task.status === 'planning' || task.status === 'draft') planning = 'active'
  else if (task.status === 'planning_failed') planning = 'failed'
  else if (hasPlan || ['plan_ready', 'plan_approved', 'executing', 'done', 'failed'].includes(task.status)) planning = 'passed'
  phases.push({ kind: 'planning', label: 'Planning', state: planning })

  // Executing
  const eState = execState(task, execution)
  const steps = execution?.steps ?? []
  const doneSteps = steps.filter((s: StepExecution) => s.status === 'completed').length
  phases.push({
    kind: 'executing',
    label: 'Executing steps',
    state: eState,
    hint: steps.length > 0 ? `${doneSteps}/${steps.length} steps` : undefined,
  })

  // Validation
  const vState = validationState(validation)
  const passedStages = validationStages.filter((s) => s.state === 'passed').length
  if (validation || vState !== 'pending') {
    phases.push({
      kind: 'validation',
      label: 'Validation',
      state: vState,
      hint: validationStages.length > 0 ? `${passedStages}/${validationStages.length} stages` : undefined,
    })
  }

  // Repair — one node per attempt
  if (repairSession) {
    if (repairAttempts.length === 0) {
      phases.push({ kind: 'repair', label: 'Repair', state: 'active', attempt: 1, hint: 'starting' })
    } else {
      for (const a of repairAttempts) {
        phases.push({
          kind: 'repair',
          label: `Repair · attempt ${a.attempt}`,
          state: a.state,
          attempt: a.attempt,
          hint: a.outcome,
        })
      }
    }
  }

  // Completed
  let completed: PhaseState = 'pending'
  if (task.status === 'done') completed = 'passed'
  else if (task.status === 'failed' || task.status === 'cancelled') completed = 'failed'
  phases.push({
    kind: 'completed',
    label: task.status === 'failed' ? 'Failed' : 'Completed',
    state: completed,
  })

  return phases
}

export function defaultActivePhaseKey(phases: LifecyclePhase[]): string | undefined {
  const key = (p: LifecyclePhase) => (p.attempt != null ? `${p.kind}-${p.attempt}` : p.kind)
  const active = [...phases].reverse().find((p) => p.state === 'active')
  if (active) return key(active)
  const lastDone = [...phases].reverse().find((p) => p.state !== 'pending')
  return lastDone ? key(lastDone) : 'created'
}
