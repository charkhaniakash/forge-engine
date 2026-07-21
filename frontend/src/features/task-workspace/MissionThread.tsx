import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Icon } from '@/components/common'
import { PlanStepCard } from '@/features/planning/PlanStepCard'
import { ThoughtGroup } from './ThoughtGroup'
import { ActivityRow } from './ActivityRow'
import { FileChanges } from './FileChanges'
import { ValidationStages } from './ValidationStages'
import { RepairAttemptCard } from './RepairAttemptCard'
import type { ConversationEntry } from './model'
import styles from './MissionThread.module.css'

export interface MissionThreadProps {
  header: ReactNode
  hero?: ReactNode
  entries: ConversationEntry[]
  live: boolean
  planActions?: ReactNode
  actionRow?: ReactNode
  trailingMessages?: string[]
  composer?: ReactNode
  /** Fallback shown when entries is empty — the caller should provide this
   *  from the backend's status/event data, but a generic fallback prevents
   *  rendering "undefined" during the initial load race. */
  emptyLabel?: string
}

// ── Entry-type color palette (UI chrome, not reasoning content) ─────────
const ENTRY_COLORS: Record<string, string> = {
  plan:       '#00FF66',
  work:       '#00E5FF',
  files:      '#42A5F5',
  validation: '#FFA726',
  repair:     '#EF5350',
  publish:    '#00FF66',
}

function entryColor(entry: ConversationEntry): string {
  return ENTRY_COLORS[entry.type] ?? '#71717A'
}

// ── Timeline Dot ────────────────────────────────────────────────────────

function TimelineDot({ color, active }: { color: string; active: boolean }) {
  return (
    <div className={styles.timelineDot} style={{ borderColor: color }}>
      <span
        className={`${styles.dotInner} ${active ? styles.dotPulse : ''}`}
        style={{ background: color }}
      />
    </div>
  )
}

// ── Card shell — purely visual chrome ─────────────────────────────────

function CardShell({ entry, header, children }: {
  entry: ConversationEntry
  header: ReactNode
  children: ReactNode
}) {
  const color = entryColor(entry)
  return (
    <div className={styles.phaseCard} style={{ borderColor: `${color}33` }}>
      {header && (
        <div
          className={styles.cardHeader}
          style={{ background: `${color}0D`, borderBottomColor: `${color}22` }}
        >
          {header}
        </div>
      )}
      <div className={styles.cardBody}>{children}</div>
    </div>
  )
}

// ── Entry renderers — ALL text comes from backend data ─────────────────

function UserBubble({ text, createdAt }: { text: string; createdAt?: string }) {
  return (
    <div className={styles.userMessageRow}>
      <div className={styles.userBubble}>
        <div className={styles.userBubbleText}>{text}</div>
        {createdAt && (
          <div className={styles.userBubbleMeta}>
            You · {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanEntry({ entry, actions }: { entry: Extract<ConversationEntry, { type: 'plan' }>; actions?: ReactNode }) {
  const { plan } = entry
  const color = entryColor(entry)
  const stepCount = `${plan.body.steps.length} step${plan.body.steps.length === 1 ? '' : 's'}`
  // Card header text is derived SOLELY from the backend plan object
  const headerTitle = plan.body.intent_summary
    ? `${plan.body.intent_summary.slice(0, 60)}${plan.body.intent_summary.length > 60 ? '…' : ''}`
    : stepCount

  return (
    <div className={styles.entryRow}>
      <TimelineDot color={color} active={false} />
      <div className={styles.entryContent}>
        <CardShell entry={entry} header={
          <div className={styles.cardHeaderInner}>
            <Icon name="execution" size={14} className={styles.cardHeaderIcon} style={{ color }} />
            <span className={styles.cardHeaderTitle}>{headerTitle}</span>
            <span
              className={styles.cardHeaderBadge}
              style={{
                color,
                background: `${color}15`,
                borderColor: `${color}30`,
              }}
            >
              {stepCount}
            </span>
          </div>
        }>
          <p className={styles.planSummary}>{plan.body.intent_summary}</p>
          <div className={styles.planSteps}>
            {plan.body.steps.map((step, i) => <PlanStepCard key={step.id} step={step} index={i} />)}
          </div>
          {actions && <div className={styles.planActions}>{actions}</div>}
        </CardShell>
      </div>
    </div>
  )
}

function WorkEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'work' }> }) {
  const color = entryColor(entry)
  // No card wrapper — the ThoughtGroup itself shows each backend-reasoning event directly
  return (
    <div className={styles.entryRow}>
      <TimelineDot color={entry.isLive ? color : '#2A2A3A'} active={entry.isLive} />
      <div className={styles.entryContent}>
        <ThoughtGroup group={entry.group} isLive={entry.isLive} />
      </div>
    </div>
  )
}

function FilesEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'files' }> }) {
  const color = entryColor(entry)
  const totalAdd = entry.files.reduce((a, f) => a + f.linesAdded, 0)
  const totalDel = entry.files.reduce((a, f) => a + f.linesRemoved, 0)
  // ALL text derived from backend file data
  const count = `${entry.files.length} file${entry.files.length === 1 ? '' : 's'} changed`
  const stats = `+${totalAdd}  −${totalDel}`

  return (
    <div className={styles.entryRow}>
      <TimelineDot color={color} active={false} />
      <div className={styles.entryContent}>
        <CardShell entry={entry} header={
          <div className={styles.cardHeaderInner}>
            <Icon name="code" size={14} className={styles.cardHeaderIcon} style={{ color }} />
            <span className={styles.cardHeaderTitle}>{count}</span>
            <span className={styles.filesHeaderStats}>{stats}</span>
          </div>
        }>
          <FileChanges files={entry.files} />
        </CardShell>
      </div>
    </div>
  )
}

function ValidationEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'validation' }> }) {
  const color = entryColor(entry)
  const running = entry.overall == null
  const passed = entry.overall === 'passed'

  const passedStages = entry.stages.filter((s) => s.state === 'passed').length
  const failedStages = entry.stages.filter((s) => s.state === 'failed').length
  const total = entry.stages.length

  // Card title from backend stage names
  const stageNames = entry.stages.map((s) => s.name).filter(Boolean)
  const titleText = stageNames.length > 0
    ? stageNames.slice(0, 3).join(', ') + (stageNames.length > 3 ? ` +${stageNames.length - 3}` : '')
    : `${total} task${total === 1 ? '' : 's'}`

  // Status text from backend stage data
  const statusText = running
    ? `${passedStages + failedStages}/${total} complete`
    : passed
      ? `${total}/${total} passed`
      : `${passedStages}/${total} passed, ${failedStages} failed`

  return (
    <div className={styles.entryRow}>
      <TimelineDot
        color={passed ? '#00FF66' : !running && !passed ? '#EF5350' : color}
        active={running}
      />
      <div className={styles.entryContent}>
        <CardShell entry={entry} header={
          <div className={styles.cardHeaderInner}>
            <Icon name="check" size={14} className={styles.cardHeaderIcon} style={{ color }} />
            <span className={styles.cardHeaderTitle}>{titleText}</span>
            <span
              className={styles.cardHeaderBadge}
              style={{
                color: passed ? '#00FF66' : '#FFA726',
                background: passed ? 'rgba(0,255,102,0.15)' : 'rgba(255,167,38,0.15)',
                borderColor: passed ? 'rgba(0,255,102,0.3)' : 'rgba(255,167,38,0.3)',
              }}
            >
              {statusText}
            </span>
          </div>
        }>
          {/* Test results from backend stage data */}
          <div className={styles.testGrid}>
            <div className={styles.testStatBox}>
              <span className={styles.testStatLabel}>Tests</span>
              <span className={styles.testStatValue}>{total}</span>
            </div>
            <div className={styles.testStatBox}>
              <span className={styles.testStatLabel}>Passed</span>
              <span className={styles.testStatValue}>{passedStages}</span>
            </div>
            <div className={styles.testStatBox}>
              <span className={styles.testStatLabel}>Failed</span>
              <span className={styles.testStatValue}>{failedStages}</span>
            </div>
          </div>
          <ValidationStages stages={entry.stages} title="" />
        </CardShell>
      </div>
    </div>
  )
}

function RepairEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'repair' }> }) {
  const color = entryColor(entry)
  // No CardShell wrapper — render each RepairAttemptCard inline, similar to
  // WorkEntry rendering ThoughtGroup directly. RepairAttemptCard already has
  // its own card styling (colored left border, background), so an outer card
  // would create a nested-card look.
  return (
    <div className={styles.entryRow}>
      <TimelineDot color={color} active={false} />
      <div className={styles.entryContent}>
        <div className={styles.repairStack}>
          {entry.attempts.map((a) => <RepairAttemptCard key={a.attempt} attempt={a} />)}
        </div>
      </div>
    </div>
  )
}

function PublishEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'publish' }> }) {
  const color = entryColor(entry)
  const { session } = entry
  const failed = session.status === 'failed'
  const ready = session.status === 'completed' && session.pr_url

  // ALL text derived from backend PublishingSession data — only uses fields
  // that actually exist on the PublishingSession type.
  const statusText = ready
    ? `PR${session.pr_number ? ` #${session.pr_number}` : ''}`
    : failed
      ? session.status
      : session.current_step ?? session.status

  const titleText = ready
    ? `${session.branch_name ?? 'Branch'} pushed${session.pr_number ? ` — PR #${session.pr_number}` : ''}`
    : failed
      ? session.error_message ?? session.status
      : session.current_step ?? session.status

  const descText = ready
    ? session.branch_name
      ? `Branch: ${session.branch_name}`
      : ''
    : failed
      ? session.error_message ?? ''
      : ''

  return (
    <div className={styles.entryRow}>
      <TimelineDot color={ready ? '#00FF66' : failed ? '#EF5350' : color} active={false} />
      <div className={styles.entryContent}>
        <CardShell entry={entry} header={
          <div className={styles.cardHeaderInner}>
            <Icon name="git" size={14} className={styles.cardHeaderIcon} style={{ color }} />
            <span className={styles.cardHeaderTitle}>{titleText}</span>
            <span
              className={styles.cardHeaderBadge}
              style={{
                color: ready ? '#00FF66' : failed ? '#EF5350' : color,
                background: ready ? 'rgba(0,255,102,0.15)' : failed ? 'rgba(239,83,80,0.15)' : `${color}15`,
                borderColor: ready ? 'rgba(0,255,102,0.3)' : failed ? 'rgba(239,83,80,0.3)' : `${color}30`,
              }}
            >
              {statusText}
            </span>
          </div>
        }>
          <div className={styles.publishBody}>
            <Icon name="git" size={22} className={styles.publishIcon} />
            <div className={styles.publishInfo}>
              <p className={styles.publishDesc}>{descText}</p>
            </div>
          </div>

          {ready && session.pr_url && (
            <div className={styles.publishActions}>
              <a
                className={styles.publishViewBtn}
                href={session.pr_url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="externalLink" size={13} />
                <span>Open PR #{session.pr_number ?? ''}</span>
              </a>
            </div>
          )}
        </CardShell>
      </div>
    </div>
  )
}

function MessageEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'message' }> }) {
  return (
    <div className={styles.entryRow}>
      <div className={styles.timelineDotSmall}>
        <span className={styles.dotNode} />
      </div>
      <div className={styles.entryContentCompact}>
        <ActivityRow ev={entry.event} />
      </div>
    </div>
  )
}

function renderEntry(entry: ConversationEntry, planActions?: ReactNode): ReactNode {
  switch (entry.type) {
    case 'work':
      return <WorkEntry entry={entry} />
    case 'message':
      return <MessageEntry entry={entry} />
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
 * Timeline-style Mission thread. NO text is hardcoded — every string
 * displayed is derived from backend events or entry data.
 */
export function MissionThread({ header, hero, entries, live, planActions, actionRow, trailingMessages, composer, emptyLabel = 'Waiting for the agent...' }: MissionThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const turnBorders = useTurnInfo(entries)
  const boundarySet = useMemo(() => new Set(turnBorders), [turnBorders])

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

  // Thinking indicator: only shown as fallback when `live` is true but no
  // work group from the backend is already rendering reasoning content.
  const lastEntry = entries[entries.length - 1]
  const needsThinkingFallback =
    live && !(lastEntry?.type === 'work' && lastEntry.isLive)

  return (
    <div className={styles.page}>
      <div className={styles.top}>{header}</div>
      <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
        <div className={styles.thread}>
          {hero && <div className={styles.heroSlot}>{hero}</div>}

          {entries.length === 0 && <div className={styles.empty}>{emptyLabel}</div>}

          <div className={styles.timeline}>
            {entries.map((entry, i) => {
              const key = entryKey(entry, i)
              const isUserMsg = entry.type === 'user'

              const turnSep = boundarySet.has(i) ? (
                <div className={styles.turnSep} key={`${key}-sep`}>
                  <span className={styles.turnSepLine} />
                  <span className={styles.turnSepLabel}>Follow-up</span>
                  <span className={styles.turnSepLine} />
                </div>
              ) : null

              const inner = isUserMsg ? (
                <UserBubble text={entry.text} createdAt={entry.createdAt} />
              ) : (
                renderEntry(entry, entry.type === 'plan' && i === lastPlanIndex ? planActions : undefined)
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

            {needsThinkingFallback && (
              <div className={styles.entryRow}>
                <div className={styles.timelineDotPulse}>
                  <span className={styles.thinkingDot} />
                </div>
                <div className={styles.entryContent}>
                  <div className={styles.thinkingRow}>
                    <span className={styles.thinkingLabel}>Forge is thinking</span>
                    <span className={styles.thinkingDots}>
                      <span className={styles.dot1}>.</span>
                      <span className={styles.dot2}>.</span>
                      <span className={styles.dot3}>.</span>
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {trailingMessages && trailingMessages.length > 0 && (
            <div className={styles.trailingMessages}>
              {trailingMessages.map((msg, i) => (
                <UserBubble key={`user-msg-${i}`} text={msg} />
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
