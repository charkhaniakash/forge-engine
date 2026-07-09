/**
 * View-model for the task-centric workspace.
 *
 * The workspace never renders raw backend entities (executions, validation
 * runs, repair sessions/attempts). Instead, live socket events + REST snapshots
 * are normalized into these shapes so the UI reads as one continuous story of
 * an engineer working — not a set of database tables.
 */
import type { Tone } from '@/constants/status'

/** The phases of a task's lifecycle, in canonical order. */
export type LifecyclePhaseKind =
  | 'created'
  | 'planning'
  | 'executing'
  | 'validation'
  | 'repair'
  | 'completed'

export type PhaseState = 'pending' | 'active' | 'passed' | 'failed' | 'skipped'

export interface LifecyclePhase {
  kind: LifecyclePhaseKind
  label: string
  state: PhaseState
  /** Short status line shown under the label (e.g. "3/4 stages", "attempt 2"). */
  hint?: string
  /** Repair produces one phase node per attempt; this disambiguates them. */
  attempt?: number
}

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
}

/** One validation stage (install/build/test/lint) as shown live. */
export interface ValidationStageVM {
  name: string
  state: PhaseState
  /** Streaming log lines while running; truncated tail is fine. */
  log: string[]
  durationMs?: number
  exitCode?: number
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
