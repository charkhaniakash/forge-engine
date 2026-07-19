import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '@/components/common'
import type { IconName } from '@/components/common'
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

type NodeTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral'

function filesSubtitle(files: { linesAdded: number; linesRemoved: number }[]): string {
  const add = files.reduce((a, f) => a + f.linesAdded, 0)
  const del = files.reduce((a, f) => a + f.linesRemoved, 0)
  return `+${add} −${del}`
}

function PlanEntry({ entry, actions }: { entry: Extract<ConversationEntry, { type: 'plan' }>; actions?: ReactNode }) {
  const { plan } = entry
  return (
    <ArtifactCard
      icon="file"
      title={`Plan ready — ${plan.body.steps.length} step${plan.body.steps.length === 1 ? '' : 's'}`}
      subtitle={plan.body.affected_files.length > 0 ? `${plan.body.affected_files.length} files` : undefined}
      defaultOpen={Boolean(actions)}
    >
      <p className={styles.planSummary}>{plan.body.intent_summary}</p>
      <div className={styles.planSteps}>
        {plan.body.steps.map((step, i) => <PlanStepCard key={step.id} step={step} index={i} />)}
      </div>
      {actions && <div className={styles.planActions}>{actions}</div>}
    </ArtifactCard>
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
  // Non-blocking policy: any non-passed result is advisory, not a failure.
  const hasIssues = !running && !passed

  const passedStages = entry.stages.filter((s) => s.state === 'passed').length
  const problemStages = entry.stages.filter(
    (s) => s.state === 'failed' || (s.exitCode != null && s.exitCode !== 0),
  ).length

  const title = running
    ? 'Validation running'
    : passed
      ? 'Validation passed'
      : `Validation — ${problemStages} ${problemStages === 1 ? 'stage' : 'stages'} reported issues`

  const subtitle = hasIssues
    ? `${passedStages}/${entry.stages.length} stages clean · advisory — won't block publishing`
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
      title={failed ? 'Repair needs your input' : `Repaired automatically — ${entry.attempts.length} attempt${entry.attempts.length === 1 ? '' : 's'}`}
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
      title={ready ? `Pull request ready — #${session.pr_number}` : failed ? 'Publishing failed' : `Publishing… ${session.current_step ?? ''}`}
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

/** Icon + tone for the timeline node marker of each entry type. */
function nodeMeta(entry: ConversationEntry): { icon: IconName; tone: NodeTone } {
  switch (entry.type) {
    case 'intent':
      return { icon: 'chat', tone: 'accent' }
    case 'user':
      return { icon: 'chat', tone: 'accent' }
    case 'work':
      return { icon: entry.group.hasToolActivity ? 'tool' : 'sparkles', tone: 'neutral' }
    case 'message':
      return { icon: 'dot', tone: 'neutral' }
    case 'plan':
      return { icon: 'file', tone: 'accent' }
    case 'files':
      return { icon: 'code', tone: 'accent' }
    case 'validation':
      return {
        icon: entry.overall === 'passed' ? 'check' : entry.overall == null ? 'clock' : 'alert',
        tone: entry.overall === 'passed' ? 'success' : entry.overall == null ? 'neutral' : 'warning',
      }
    case 'repair':
      return { icon: 'repair', tone: 'success' }
    case 'publish':
      return {
        icon: 'git',
        tone: entry.session.status === 'completed' ? 'success' : entry.session.status === 'failed' ? 'danger' : 'neutral',
      }
    default:
      return { icon: 'dot', tone: 'neutral' }
  }
}

function renderEntry(entry: ConversationEntry, planActions?: ReactNode): ReactNode {
  switch (entry.type) {
    case 'intent':
      return <div className={styles.intent}>{entry.text}</div>
    case 'user':
      return <div className={styles.userMessage}>{entry.text}</div>
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
 * The Mission page: one continuous, timeline-style conversation. The hero shows
 * the current phase at a glance; below it, every step — thinking, tool use,
 * plan/files/validation/repair/publish outcomes — hangs off a connected spine.
 */
export function MissionThread({ header, hero, entries, live, planActions, actionRow, trailingMessages, composer, emptyLabel = 'Waiting for the agent…' }: MissionThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

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

          <div className={styles.timeline}>
            {entries.map((entry, i) => {
              const { icon, tone } = nodeMeta(entry)
              return (
                <div className={styles.row} key={entryKey(entry, i)}>
                  <div className={styles.gutter}>
                    <span className={`${styles.node} ${styles[`node_${tone}`]}`}>
                      <Icon name={icon} size={13} />
                    </span>
                  </div>
                  <div className={styles.content}>{renderEntry(entry, planActions)}</div>
                </div>
              )
            })}

            {live && (
              <div className={styles.row}>
                <div className={styles.gutter}>
                  <span className={`${styles.node} ${styles.node_accent} ${styles.nodeLive}`}>
                    <Icon name="sparkles" size={13} />
                  </span>
                </div>
                <div className={styles.content}>
                  <div className={styles.working}>
                    <span className={styles.cursor}>▋</span> working…
                  </div>
                </div>
              </div>
            )}
          </div>

          {trailingMessages && trailingMessages.length > 0 && (
            <div className={styles.userMessages}>
              {trailingMessages.map((msg, i) => (
                <div key={`user-msg-${i}`} className={styles.userMessage}>{msg}</div>
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
