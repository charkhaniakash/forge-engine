import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/common'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PlanStepCard } from '@/features/planning/PlanStepCard'
import { ThoughtGroup } from './ThoughtGroup'
import { ActivityRow } from './ActivityRow'
import { FileChanges } from './FileChanges'
import { ValidationStages } from './ValidationStages'
import { RepairAttemptCard } from './RepairAttemptCard'
import type { ConversationEntry } from './model'
import { cn } from '@/lib/utils'

export interface MissionThreadProps {
  header: ReactNode
  hero?: ReactNode
  entries: ConversationEntry[]
  live: boolean
  planActions?: ReactNode
  actionRow?: ReactNode
  trailingMessages?: string[]
  /** Fallback shown when entries is empty — the caller should provide this
   *  from the backend's status/event data, but a generic fallback prevents
   *  rendering "undefined" during the initial load race. */
  composer?: ReactNode
  emptyLabel?: string
}

// ── Entry-type accent (icon color) ──────────────────────────────────────
const ENTRY_ICON_COLOR: Record<string, string> = {
  plan:       'text-primary',
  work:       'text-info',
  files:      'text-info',
  validation: 'text-warning',
  repair:     'text-destructive',
  publish:    'text-primary',
}

// ── Compact card shell built on the shadcn Card primitive ───────────────
function CardShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden border-border bg-card py-0 shadow-sm">
      {header && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">{header}</div>
      )}
      <div className="p-3">{children}</div>
    </Card>
  )
}

function CardHeaderInner({ icon, color, title, badge }: {
  icon: Parameters<typeof Icon>[0]['name']
  color: string
  title: string
  badge?: ReactNode
}) {
  return (
    <>
      <Icon name={icon} size={14} className={cn('flex-shrink-0', color)} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{title}</span>
      {badge}
    </>
  )
}

// ── Entry renderers — ALL text comes from backend data ─────────────────

function UserBubble({ text, createdAt }: { text: string; createdAt?: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-primary/20 bg-primary/10 px-3 py-2">
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{text}</div>
        {createdAt && (
          <div className="mt-1 text-[10px] text-fg-subtle">
            You · {new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  )
}

function PlanEntry({ entry, actions }: { entry: Extract<ConversationEntry, { type: 'plan' }>; actions?: ReactNode }) {
  const { plan } = entry
  const stepCount = `${plan.body.steps.length} step${plan.body.steps.length === 1 ? '' : 's'}`
  const headerTitle = plan.body.intent_summary
    ? `${plan.body.intent_summary.slice(0, 60)}${plan.body.intent_summary.length > 60 ? '…' : ''}`
    : stepCount

  return (
    <CardShell
      header={
        <CardHeaderInner
          icon="execution"
          color={ENTRY_ICON_COLOR.plan}
          title={headerTitle}
          badge={<Badge variant="outline" className="border-primary/30 font-normal text-primary">{stepCount}</Badge>}
        />
      }
    >
      <p className="mb-3 text-[13px] leading-relaxed text-fg-muted">{plan.body.intent_summary}</p>
      <div className="flex flex-col gap-2">
        {plan.body.steps.map((step, i) => <PlanStepCard key={step.id} step={step} index={i} />)}
      </div>
      {actions && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </CardShell>
  )
}

function WorkEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'work' }> }) {
  return <ThoughtGroup group={entry.group} isLive={entry.isLive} />
}

function FilesEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'files' }> }) {
  const totalAdd = entry.files.reduce((a, f) => a + f.linesAdded, 0)
  const totalDel = entry.files.reduce((a, f) => a + f.linesRemoved, 0)
  const count = `${entry.files.length} file${entry.files.length === 1 ? '' : 's'} changed`

  return (
    <CardShell
      header={
        <CardHeaderInner
          icon="code"
          color={ENTRY_ICON_COLOR.files}
          title={count}
          badge={
            <span className="flex-shrink-0 font-mono text-[11px]">
              <span className="text-success">+{totalAdd}</span>{' '}
              <span className="text-destructive">−{totalDel}</span>
            </span>
          }
        />
      }
    >
      <FileChanges files={entry.files} />
    </CardShell>
  )
}

function ValidationEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'validation' }> }) {
  const running = entry.overall == null
  const passed = entry.overall === 'passed'

  const passedStages = entry.stages.filter((s) => s.state === 'passed').length
  const failedStages = entry.stages.filter((s) => s.state === 'failed').length
  const total = entry.stages.length

  const stageNames = entry.stages.map((s) => s.name).filter(Boolean)
  const titleText = stageNames.length > 0
    ? stageNames.slice(0, 3).join(', ') + (stageNames.length > 3 ? ` +${stageNames.length - 3}` : '')
    : `${total} task${total === 1 ? '' : 's'}`

  const statusText = running
    ? `${passedStages + failedStages}/${total} complete`
    : passed
      ? 'All checks passed'
      : `${passedStages}/${total} passed, ${failedStages} with feedback`

  return (
    <CardShell
      header={
        <CardHeaderInner
          icon="check"
          color={passed ? 'text-success' : !running && !passed ? 'text-destructive' : ENTRY_ICON_COLOR.validation}
          title={titleText}
          badge={
            <Badge
              variant="outline"
              className={cn('font-normal', passed ? 'border-success/30 text-success' : 'border-warning/30 text-warning')}
            >
              {statusText}
            </Badge>
          }
        />
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[
          { label: 'Tests', value: total },
          { label: 'Passed', value: passedStages },
          { label: 'Feedback', value: failedStages },
        ].map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-0.5 rounded-lg border border-border bg-background/40 py-2.5">
            <span className="font-mono text-lg font-semibold tabular-nums text-fg">{s.value}</span>
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">{s.label}</span>
          </div>
        ))}
      </div>
      <ValidationStages stages={entry.stages} title="" />
    </CardShell>
  )
}

function RepairEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'repair' }> }) {
  return (
    <div className="flex flex-col gap-2">
      {entry.attempts.map((a) => <RepairAttemptCard key={a.attempt} attempt={a} />)}
    </div>
  )
}

function PublishEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'publish' }> }) {
  const { session } = entry
  const needsAttention = session.status === 'failed'
  const ready = session.status === 'completed' && session.pr_url

  const statusText = ready
    ? `PR${session.pr_number ? ` #${session.pr_number}` : ''}`
    : needsAttention
      ? 'Needs attention'
      : session.current_step ?? session.status

  const titleText = ready
    ? `${session.branch_name ?? 'Branch'} pushed${session.pr_number ? ` — PR #${session.pr_number}` : ''}`
    : needsAttention
      ? session.error_message ?? session.status
      : session.current_step ?? session.status

  const descText = ready
    ? session.branch_name ? `Branch: ${session.branch_name}` : ''
    : needsAttention
      ? session.error_message ?? ''
      : ''

  return (
    <CardShell
      header={
        <CardHeaderInner
          icon="git"
          color={ready ? 'text-success' : needsAttention ? 'text-warning' : ENTRY_ICON_COLOR.publish}
          title={titleText}
          badge={
            <Badge
              variant="outline"
              className={cn(
                'font-normal',
                ready ? 'border-success/30 text-success' : needsAttention ? 'border-warning/30 text-warning' : 'border-primary/30 text-primary',
              )}
            >
              {statusText}
            </Badge>
          }
        />
      }
    >
      <div className="flex items-center gap-3">
        <Icon name="git" size={20} className="flex-shrink-0 text-fg-subtle" />
        <p className="min-w-0 flex-1 text-xs text-fg-muted">{descText}</p>
      </div>
      {ready && session.pr_url && (
        <a
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground no-underline transition-all hover:no-underline hover:brightness-110"
          href={session.pr_url}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="externalLink" size={13} />
          <span>Open PR #{session.pr_number ?? ''}</span>
        </a>
      )}
    </CardShell>
  )
}

function MessageEntry({ entry }: { entry: Extract<ConversationEntry, { type: 'message' }> }) {
  return <ActivityRow ev={entry.event} />
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
export function MissionThread({ header, entries, live, planActions, actionRow, trailingMessages, composer, emptyLabel = 'Waiting for the agent...' }: MissionThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  // Pinned = user is parked at the bottom and wants to follow live output.
  // Once they scroll up to inspect an earlier change, we STOP yanking them down.
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const turnBorders = useTurnInfo(entries)
  const boundarySet = useMemo(() => new Set(turnBorders), [turnBorders])

  const lastPlanIndex = useMemo(() => {
    let last = -1
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].type === 'plan') last = i
    }
    return last
  }, [entries])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    pinnedRef.current = true
    setShowJump(false)
  }, [])

  // Follow streaming growth: content grows INSIDE an existing entry (execution
  // output, appending reasoning) without the entry count changing. A ResizeObserver
  // catches every height change and keeps us glued to the bottom — but only while pinned.
  useEffect(() => {
    const content = threadRef.current
    const el = scrollRef.current
    if (!content || !el) return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // New entries / new user messages: jump down only if the user is still pinned.
  useEffect(() => {
    if (pinnedRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [entries.length, trailingMessages?.length])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = distanceFromBottom < 80
    pinnedRef.current = pinned
    setShowJump(!pinned)
  }

  // Thinking indicator: only shown as fallback when `live` is true but no
  // work group from the backend is already rendering reasoning content.
  const lastEntry = entries[entries.length - 1]
  const needsThinkingFallback = live && !(lastEntry?.type === 'work' && lastEntry.isLive)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-base">
      <div className="relative flex-1 overflow-y-auto" ref={scrollRef} onScroll={onScroll}>
        <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-5 py-5 pb-16" ref={threadRef}>
          {header}

          {entries.length === 0 && (
            <div className="py-8 text-center text-[13px] text-fg-subtle">{emptyLabel}</div>
          )}

          {entries.map((entry, i) => {
            const key = entryKey(entry, i)
            const isUserMsg = entry.type === 'user'

            const turnSep = boundarySet.has(i) ? (
              <div className="my-2 flex items-center gap-3" key={`${key}-sep`}>
                <span className="h-px flex-1 bg-line-subtle" />
                <span className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">Follow-up</span>
                <span className="h-px flex-1 bg-line-subtle" />
              </div>
            ) : null

            const inner = isUserMsg ? (
              <UserBubble text={entry.text} createdAt={entry.createdAt} />
            ) : (
              renderEntry(entry, entry.type === 'plan' && i === lastPlanIndex ? planActions : undefined)
            )

            return (
              <div key={key} className="flex flex-col gap-3">
                {turnSep}
                {inner}
              </div>
            )
          })}

          {needsThinkingFallback && (
            <div className="flex items-center gap-2 px-2 py-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
              <span className="text-[13px] text-fg-muted">Forge is thinking</span>
              <span className="flex gap-0.5">
                <span className="animate-bounce text-fg-subtle [animation-delay:-0.3s]">.</span>
                <span className="animate-bounce text-fg-subtle [animation-delay:-0.15s]">.</span>
                <span className="animate-bounce text-fg-subtle">.</span>
              </span>
            </div>
          )}

          {trailingMessages && trailingMessages.length > 0 && (
            <div className="flex flex-col gap-3">
              {trailingMessages.map((msg, i) => <UserBubble key={`user-msg-${i}`} text={msg} />)}
            </div>
          )}

          {actionRow && <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{actionRow}</div>}
          <div ref={endRef} />
        </div>

        {showJump && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label="Jump to latest"
            className="sticky bottom-3.5 left-1/2 z-10 -translate-x-1/2 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2/90 px-3.5 py-1.5 text-xs font-medium text-fg-muted shadow-lg backdrop-blur transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Icon name="chevronDown" size={14} />
            {live ? 'Follow live' : 'Latest'}
          </button>
        )}
      </div>

      {composer && (
        <div className="flex-shrink-0 border-t border-line bg-base px-4 py-3">
          <div className="mx-auto max-w-[860px]">{composer}</div>
        </div>
      )}
    </div>
  )
}
