/**
 * View-model for the task-centric workspace.
 *
 * The workspace never renders raw backend entities (executions, validation
 * runs, repair sessions/attempts). Instead, live socket events + REST snapshots
 * are normalized into these shapes so the UI reads as one continuous story of
 * an engineer working — not a set of database tables.
 */
import type { Tone } from '@/constants/status'
import type { Plan } from '@/types'
import type { PublishingSession } from '@/types/publishing'

/** The phases of a task's lifecycle, in canonical order — still used to tag/order events, even without a dedicated rail UI. */
export type LifecyclePhaseKind =
  | 'created'
  | 'planning'
  | 'executing'
  | 'validation'
  | 'repair'
  | 'publishing'
  | 'completed'

export type PhaseState = 'pending' | 'active' | 'passed' | 'failed' | 'skipped'

/** Kinds of entries in the unified activity feed. */
export type ActivityKind =
  | 'status' // phase transitions / milestones
  | 'reasoning' // model thinking
  | 'tool_call' // agent invoked a tool
  | 'tool_result' // tool returned
  | 'validation' // a validation stage event
  | 'repair' // a repair milestone
  | 'diff' // a file was changed
  | 'error'

/** A single normalized line in the terminal-style activity feed. */
export interface ActivityEvent {
  /** Stable id for React keys + de-dup (seq or synthetic). */
  id: string
  /** Monotonic ordering key. */
  seq: number
  phase: LifecyclePhaseKind
  kind: ActivityKind
  /** Primary text, e.g. "Reading App.tsx" or "Root cause identified". */
  title: string
  /** Secondary text: file path, args preview, match count, exit code. */
  detail?: string
  tone: Tone
  /** For tool_call rows: the tool, so we can pick an icon. */
  tool?: string
  /** Terminal state of a tool/stage row, drives the trailing ✓/✗/spinner. */
  outcome?: 'running' | 'ok' | 'fail'
  /** Client-perceived arrival time (ms epoch) — used to label collapsed groups. */
  atMs?: number
}

/** A run of consecutive `reasoning`/`tool_call`/`tool_result` events collapsed behind one summary line. */
export interface WorkGroup {
  id: string
  events: ActivityEvent[]
  /** Elapsed time from first to last event in the group, if both are timestamped. */
  durationMs?: number
  /** True when the group includes tool use (not just reasoning) — drives "Worked" vs "Thought" labeling. */
  hasToolActivity: boolean
}

/** One entry in a grouped work feed: a collapsed burst, or an always-visible milestone. */
export type WorkEntry =
  | { type: 'group'; group: WorkGroup; isLive: boolean }
  | { type: 'pinned'; event: ActivityEvent }

/**
 * One entry in the Mission thread — the single conversation-first view of a
 * task. Planning/execution/validation/repair/publishing are backend phases;
 * here they're just chronological events and artifact cards in one feed.
 */
export type ConversationEntry =
  | { type: 'intent'; text: string }
  | { type: 'user'; text: string; turnNumber: number; createdAt: string }
  | { type: 'work'; group: WorkGroup; isLive: boolean }
  | { type: 'message'; event: ActivityEvent }
  | { type: 'plan'; plan: Plan }
  | { type: 'files'; files: FileChangeVM[] }
  | { type: 'validation'; stages: ValidationStageVM[]; overall?: string }
  | { type: 'repair'; attempts: RepairAttemptVM[] }
  | { type: 'publish'; session: PublishingSession }

/** One validation stage (install/build/test/lint) as shown live. */
export interface ValidationStageVM {
  name: string
  state: PhaseState
  /** Streaming log lines while running; truncated tail is fine. */
  log: string[]
  durationMs?: number
  exitCode?: number
  /**
   * Richer outcome classified by the backend validation engine.
   * Absent on legacy runs — fall back to (state + exitCode) for display.
   * - "passed"             → green
   * - "failed"             → red
   * - "no_tests"           → neutral/info  (not a failure)
   * - "infrastructure_error" → amber/warning (not a code failure)
   */
  outcome?: 'passed' | 'failed' | 'no_tests' | 'infrastructure_error'
  /**
   * For skipped stages: the reason provided by the backend.
   * When the reason starts with "misconfigured:", render as "Misconfigured" (amber).
   * Strip the "skipped: " / "misconfigured: " prefix for display.
   */
  reason?: string
}

/** A single repair attempt, rendered inline in the timeline. */
export interface RepairAttemptVM {
  attempt: number
  state: PhaseState
  strategy?: string
  confidence?: number
  rootCause?: string
  filesModified: string[]
  outcome?: string // passed | improved | no_change | regressed | cannot_repair
  errorsBefore?: number
  errorsAfter?: number
}

/** A modified file with an optional unified diff for inline expansion. */
export interface FileChangeVM {
  path: string
  operation: string // create | modify | delete | rename
  linesAdded: number
  linesRemoved: number
  diff?: string
  /** How many times the agent rewrote this file during the task. */
  revisions?: number
}
