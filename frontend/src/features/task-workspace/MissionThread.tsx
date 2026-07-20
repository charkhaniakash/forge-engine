import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Icon } from '@/components/common'
import { PlanStepCard } from '@/features/planning/PlanStepCard'
import { ArtifactCard } from './ArtifactCard'
import { ThoughtGroup } from './ThoughtGroup'
import { ActivityRow } from './ActivityRow'
import { FileChanges } from './FileChanges'
import { ValidationStages } from './ValidationStages'
import { RepairAttemptCard } from './RepairAttemptCard'
import type { ConversationEntry } from './model'
import styles from './MissionThread.module.css'

export interface MissionThreadProps {
  header: ReactNode
  /** Optional status hero rendered above the timeline. */
  hero?: ReactNode
  entries: ConversationEntry[]
  live: boolean
  /** Rendered inside the plan card — approve/reject/replan, only while a decision is pending. */
  planActions?: ReactNode
  /** Rendered at the end of the thread — the one contextual next-step button. */
  actionRow?: ReactNode
  /** User follow-up messages (e.g. plan refinements) shown as chat bubbles at the end. */
  trailingMessages?: string[]
  /** Docked input at the bottom of the page (e.g. the refine-plan composer). */
  composer?: ReactNode
  emptyLabel?: string
}

function filesSubtitle(files: { linesAdded: number; linesRemoved: number }[]): string {
  const add = files.reduce((a, f) => a + f.linesAdded, 0)
  const del = files.reduce((a, f) => a + f.linesRemoved, 0)
  return `+${add} −${del}`
}

function PlanEntry({ entry, actions }: { entry: Extract<ConversationEntry, { type: 'plan' }>; actions?: ReactNode }) {
  const { plan } = entry
  return (
    <div className={styles.devinCard}>
      <div className={styles.devinCardHeader}>
        <span className={styles.devinCardIcon}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
            <path d="M4 6h8M4 9h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <span className={styles.devinCardTitle}>Plan — {plan.body.steps.length} step{plan.body.steps.length === 1 ? '' : 's'}</span>
      </div>
      <div className={styles.devinCardBody}>
        <p className={styles.planSummary}>{plan.body.intent_summary}</p>
        <div className={styles.planSteps}>
          {plan.body.steps.map((step, i) => <PlanStepCard key={step.id} step={step} index={i} />)}
        </div>
        {actions && <div className={styles.planActions}>{actions}</div>}
      </div>
    </div>
  )
}

function FilesEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'files' }> }) {
  return (
    <ArtifactCard
      icon="code"
      title={`Modified ${entry.files.length} file${entry.files.length === 1 ? '' : 's'}`}
      subtitle={filesSubtitle(entry.files)}
    >
      <FileChanges files={entry.files} />
    </ArtifactCard>
  )
}

function ValidationEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'validation' }> }) {
  const running = entry.overall == null
  const passed = entry.overall === 'passed'
  const hasIssues = !running && !passed

  const passedStages = entry.stages.filter((s) => s.state === 'passed').length
  const problemStages = entry.stages.filter(
    (s) => s.state === 'failed' || (s.exitCode != null && s.exitCode !== 0),
  ).length

  const title = running
    ? 'Validating...'
    : passed
      ? 'Validation passed'
      : `Validation — ${problemStages} ${problemStages === 1 ? 'stage' : 'stages'} reported issues`

  const subtitle = hasIssues
    ? `${passedStages}/${entry.stages.length} stages clean · advisory`
    : `${passedStages}/${entry.stages.length} stages`

  return (
    <ArtifactCard
      icon={passed ? 'check' : hasIssues ? 'alert' : 'clock'}
      title={title}
      subtitle={subtitle}
      tone={passed ? 'success' : hasIssues ? 'warning' : 'neutral'}
      defaultOpen={hasIssues}
    >
      <ValidationStages stages={entry.stages} title="" />
    </ArtifactCard>
  )
}

function RepairEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'repair' }> }) {
  const failed = entry.attempts.some((a) => a.outcome === 'cannot_repair' || a.outcome === 'regressed')
  return (
    <ArtifactCard
      icon="repair"
      title={failed ? 'Repair needs your input' : `Repaired — ${entry.attempts.length} attempt${entry.attempts.length === 1 ? '' : 's'}`}
      tone={failed ? 'danger' : 'success'}
      defaultOpen={failed}
    >
      {entry.attempts.map((a) => <RepairAttemptCard key={a.attempt} attempt={a} />)}
    </ArtifactCard>
  )
}

function PublishEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'publish' }> }) {
  const { session } = entry
  const failed = session.status === 'failed'
  const ready = session.status === 'completed' && session.pr_url
  return (
    <ArtifactCard
      icon="git"
      title={ready ? `PR ready — #${session.pr_number}` : failed ? 'Publishing failed' : `Publishing${session.current_step ? ` · ${session.current_step}` : '...'}`}
      tone={ready ? 'success' : failed ? 'danger' : 'neutral'}
      defaultOpen={failed}
    >
      {session.branch_name && (
        <div className={styles.pubRow}>
          <Icon name="branch" size={12} /> <code>{session.branch_name}</code>
        </div>
      )}
      {ready && (
        <a className={styles.pubLink} href={session.pr_url!} target="_blank" rel="noreferrer">
          <Icon name="externalLink" size={13} /> {session.pr_url!.replace(/^https?:\/\//, '')}
        </a>
      )}
      {failed && session.error_message && <div className={styles.pubError}>{session.error_message}</div>}
    </ArtifactCard>
  )
}

function renderEntry(entry: ConversationEntry, planActions?: ReactNode): ReactNode {
  switch (entry.type) {
    case 'work':
      return <ThoughtGroup group={entry.group} isLive={entry.isLive} />
    case 'message':
      return <ActivityRow ev={entry.event} />
    case 'plan':
      return <PlanEntry entry={entry} actions={planActions} />
    case 'files':
      return <FilesEntry entry={entry} />
    case 'validation':
      return <ValidationEntry entry={entry} />
    case 'repair':
      return <RepairEntry entry={entry} />
    case 'publish':
      return <PublishEntry entry={entry} />
    default:
      return null
  }
}

function entryKey(entry: ConversationEntry, i: number): string {
  switch (entry.type) {
    case 'work':
      return entry.group.id
    case 'message':
      return entry.event.id
    default:
      return `${entry.type}-${i}`
  }
}

/**
 * Detect turn boundaries from the entries array — returns indices where a
 * follow-up user message starts a new turn (turn_number > 1).
 */
function useTurnInfo(entries: ConversationEntry[]) {
  return useMemo(() => {
    const boundaries: number[] = []
    let lastTurn = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.type === 'user') {
        const tn = e.turnNumber
        if (tn > lastTurn && tn > 1) {
          boundaries.push(i)
        }
        lastTurn = Math.max(lastTurn, tn)
      }
    }
    return boundaries
  }, [entries])
}

/**
 * Devin-style Mission thread: a clean chat conversation with right-aligned user
 * bubbles, left-aligned agent responses with avatar, inline step timeline,
 * and a "Forge is thinking..." indicator.
 */
export function MissionThread({ header, hero, entries, live, planActions, actionRow, trailingMessages, composer, emptyLabel = 'Waiting for the agent...' }: MissionThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnBorders = useTurnInfo(entries)
  const boundarySet = useMemo(() => new Set(turnBorders), [turnBorders])

  // Only the LAST plan entry gets action buttons (approve/reject/replan).
  // Previous turns' plan cards are informational — no interactive controls.
  const lastPlanIndex = useMemo(() => {
    let last = -1
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === 'plan') last = i
    }
    return last
  }, [entries])

  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length, trailingMessages?.length])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <div className={styles.page}>
      <div className={styles.top}>{header}</div>
      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
        <div className={styles.thread}>
          {hero && <div className={styles.heroSlot}>{hero}</div>}

          {entries.length === 0 && <div className={styles.empty}>{emptyLabel}</div>}

          <div className={styles.feed}>
            {entries.map((entry, i) => {
              const key = entryKey(entry, i)
              const isUserMsg = entry.type === 'user'
              const isArtifact = ['plan', 'files', 'validation', 'repair', 'publish'].includes(entry.type)
              // Turn separator before user messages that start a new turn
              const turnSep = boundarySet.has(i) ? (
                <div className={styles.turnSep} key={`${key}-sep`}>
                  <span className={styles.turnSepLine} />
                  <span className={styles.turnSepLabel}>Follow-up</span>
                  <span className={styles.turnSepLine} />
                </div>
              ) : null

              const inner = isUserMsg ? (
                // Devin-style: right-aligned user chat bubble
                <div className={styles.userMessageRow}>
                  <div className={styles.userBubble}>
                    <div className={styles.userBubbleText}>{entry.text}</div>
                    <div className={styles.userBubbleMeta}>
                      You · {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ) : isArtifact || entry.type === 'work' ? (
                // Devin-style: AI response section with forge avatar + content
                <div className={styles.aiResponse}>
                  <div className={styles.aiAvatar}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
                      <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  <div className={styles.aiContent}>
                    {renderEntry(entry, entry.type === 'plan' && i === lastPlanIndex ? planActions : undefined)}
                  </div>
                </div>
              ) : (
                // Activity entries (message type) — inline with subtle styling
                <div className={styles.aiResponse}>
                  <div className={styles.aiAvatarSmall}>
                    <span className={styles.dotNode} />
                  </div>
                  <div className={styles.aiContentCompact}>
                    {renderEntry(entry, entry.type === 'plan' && i === lastPlanIndex ? planActions : undefined)}
                  </div>
                </div>
              )

              return turnSep ? (
                <div key={key}>
                  {turnSep}
                  {inner}
                </div>
              ) : (
                <div key={key}>{inner}</div>
              )
            })}

            {/* Devin-style: "Forge is thinking..." indicator */}
            {live && (
              <div className={styles.thinkingRow}>
                <div className={styles.aiAvatar}>
                  <span className={styles.thinkingDot} />
                </div>
                <div className={styles.thinkingText}>
                  <span className={styles.thinkingLabel}>Forge is thinking</span>
                  <span className={styles.thinkingDots}>
                    <span className={styles.dot1}>.</span>
                    <span className={styles.dot2}>.</span>
                    <span className={styles.dot3}>.</span>
                  </span>
                </div>
              </div>
            )}
          </div>

          {trailingMessages && trailingMessages.length > 0 && (
            <div className={styles.trailingMessages}>
              {trailingMessages.map((msg, i) => (
                <div key={`user-msg-${i}`} className={styles.userBubble}>
                  <div className={styles.userBubbleText}>{msg}</div>
                </div>
              ))}
            </div>
          )}

          {actionRow && <div className={styles.actionRow}>{actionRow}</div>}
          <div ref={endRef} />
        </div>
      </div>
      {composer && <div className={styles.composer}>{composer}</div>}
    </div>
  )
}
