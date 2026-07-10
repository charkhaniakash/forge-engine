/**
 * Pure mappers: backend entities + live socket events → workspace view models.
 * Kept side-effect free so they're trivially testable and the container stays
 * thin. Nothing here renders raw DB rows — it all becomes lifecycle phases, a
 * unified activity feed, validation stages, repair attempts, and file changes.
 */
import type { Tone } from '@/constants/status'
import type {
  CodeDiff,
  Plan,
  PlanningSocketEvent,
  ValidationStage,
} from '@/types'
import type { RepairSession, RepairSocketEvent } from '@/types/repair'
import type { PublishingSession, PublishingSocketEvent } from '@/types/publishing'
import type { ExecutionLiveEvent, ValidationLiveEvent } from '@/store/slices/streamSlice'
import type {
  ActivityEvent,
  ConversationEntry,
  FileChangeVM,
  PhaseState,
  RepairAttemptVM,
  ValidationStageVM,
  WorkEntry,
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

/** Emoji marker for an activity row, matching the "watching an engineer" language. */
export function activityMarker(ev: ActivityEvent): string {
  if (ev.kind === 'tool_call' || ev.kind === 'tool_result') {
    const t = (ev.tool ?? '').toLowerCase()
    if (t.includes('read')) return '📖'
    if (t.includes('write') || t.includes('create') || t.includes('edit')) return '✏️'
    if (t.includes('search') || t.includes('grep') || t.includes('symbol')) return '🔍'
    if (t.includes('list') || t.includes('dir') || t.includes('ls')) return '📁'
    if (t.includes('delete') || t.includes('remove')) return '🗑️'
    if (t.includes('valid') || t.includes('build') || t.includes('test') || t.includes('run')) return '🧪'
    return '🔧'
  }
  const byKind: Record<ActivityEvent['kind'], string> = {
    status: '●',
    reasoning: '💭',
    tool_call: '🔧',
    tool_result: '🔧',
    validation: '🧪',
    repair: '🩹',
    diff: '📝',
    error: '❌',
  }
  return byKind[ev.kind]
}

// ── Activity feed ─────────────────────────────────────────────────────────────

interface ActivityInputs {
  planning: PlanningSocketEvent[]
  execution: ExecutionLiveEvent[]
  validation: ValidationLiveEvent[]
  repair: RepairSocketEvent[]
  publishing: PublishingSocketEvent[]
}

export function buildActivity({ planning, execution, validation, repair, publishing }: ActivityInputs): ActivityEvent[] {
  const out: ActivityEvent[] = []
  let seq = 0
  // Set before each loop iteration below — lets push() stamp atMs without every
  // call site repeating it.
  let currentAtMs: number | undefined
  const push = (e: Omit<ActivityEvent, 'seq' | 'id' | 'atMs'>) => {
    out.push({ ...e, atMs: currentAtMs, seq, id: `${e.phase}-${seq}-${e.kind}` })
    seq += 1
  }

  for (const ev of planning) {
    currentAtMs = typeof ev.receivedAt === 'number' ? ev.receivedAt : undefined
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
    currentAtMs = le.receivedAt
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
    currentAtMs = le.receivedAt
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
    currentAtMs = ev.ts
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

  for (const ev of publishing) {
    currentAtMs = ev.ts
    switch (ev.event) {
      case 'publishing_progress':
        push({
          phase: 'publishing',
          kind: ev.status === 'failed' ? 'error' : 'status',
          title: ev.message ?? ev.step ?? '',
          detail: ev.branch,
          tone: ev.status === 'completed' ? 'success' : ev.status === 'failed' ? 'danger' : 'info',
        })
        break
      case 'publishing_complete':
        push({
          phase: 'publishing',
          kind: 'status',
          title: ev.pr_url
            ? `Pull request opened${ev.pr_number ? ` #${ev.pr_number}` : ''}`
            : 'Publishing complete',
          detail: ev.pr_url,
          tone: 'success',
        })
        break
    }
  }

  return out
}

/** "3s" under a minute, "1m 56s" otherwise — matches how Devin-style tools label collapsed thought blocks. */
export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

const WORK_KINDS = new Set<ActivityEvent['kind']>(['reasoning', 'tool_call', 'tool_result'])

/**
 * Collapse consecutive `reasoning`/`tool_call`/`tool_result` events into single
 * summary groups — "Thought for Ns" when it's pure reasoning, "Worked for Xm
 * Ys" when tool use is involved — leaving milestone events (status/repair/
 * error) always visible as boundaries between them. Only the trailing group
 * is marked live, and only while the mission itself is still running — every
 * other group defaults to collapsed.
 */
export function groupWork(events: ActivityEvent[], live: boolean): WorkEntry[] {
  const out: WorkEntry[] = []
  let current: ActivityEvent[] = []

  const flush = () => {
    if (current.length === 0) return
    const first = current[0]
    const last = current[current.length - 1]
    out.push({
      type: 'group',
      isLive: false,
      group: {
        id: `group-${first.id}`,
        events: current,
        durationMs: first.atMs != null && last.atMs != null ? last.atMs - first.atMs : undefined,
        hasToolActivity: current.some((e) => e.kind === 'tool_call' || e.kind === 'tool_result'),
      },
    })
    current = []
  }

  for (const ev of events) {
    if (WORK_KINDS.has(ev.kind)) {
      current.push(ev)
    } else {
      flush()
      out.push({ type: 'pinned', event: ev })
    }
  }
  flush()

  const lastEntry = out[out.length - 1]
  if (live && lastEntry?.type === 'group') lastEntry.isLive = true

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

// ── Conversation thread ────────────────────────────────────────────────────────

export interface ConversationInputs {
  intent: string
  planning: PlanningSocketEvent[]
  execution: ExecutionLiveEvent[]
  validation: ValidationLiveEvent[]
  repair: RepairSocketEvent[]
  publishing: PublishingSocketEvent[]
  plan?: Plan | null
  fileChanges: FileChangeVM[]
  validationStages: ValidationStageVM[]
  validationOverall?: string
  repairAttempts: RepairAttemptVM[]
  publishingSession?: PublishingSession | null
  /** Which phase is currently streaming, if any — only its trailing work group renders live/expanded. */
  livePhase?: 'planning' | 'executing' | 'validation' | 'repair' | 'publishing'
}

/**
 * Assembles the single chronological Mission thread: the task intent, then
 * each phase's grouped work interleaved with its artifact card (plan/files/
 * validation/repair/publish), in canonical — and therefore chronological —
 * phase order. Backend phase boundaries never surface as separate panels;
 * they're just where an artifact card gets inserted into one continuous feed.
 */
export function buildConversation(inp: ConversationInputs): ConversationEntry[] {
  const all = buildActivity({
    planning: inp.planning,
    execution: inp.execution,
    validation: inp.validation,
    repair: inp.repair,
    publishing: inp.publishing,
  })

  const out: ConversationEntry[] = []
  if (inp.intent) out.push({ type: 'intent', text: inp.intent })

  const pushPhaseWork = (phase: ActivityEvent['phase']) => {
    const events = all.filter((e) => e.phase === phase)
    if (events.length === 0) return
    for (const entry of groupWork(events, inp.livePhase === phase)) {
      out.push(
        entry.type === 'group'
          ? { type: 'work', group: entry.group, isLive: entry.isLive }
          : { type: 'message', event: entry.event },
      )
    }
  }

  pushPhaseWork('planning')
  if (inp.plan) out.push({ type: 'plan', plan: inp.plan })

  pushPhaseWork('executing')
  if (inp.fileChanges.length > 0) out.push({ type: 'files', files: inp.fileChanges })

  pushPhaseWork('validation')
  if (inp.validationStages.length > 0) {
    out.push({ type: 'validation', stages: inp.validationStages, overall: inp.validationOverall })
  }

  pushPhaseWork('repair')
  if (inp.repairAttempts.length > 0) out.push({ type: 'repair', attempts: inp.repairAttempts })

  pushPhaseWork('publishing')
  if (inp.publishingSession) out.push({ type: 'publish', session: inp.publishingSession })

  return out
}
