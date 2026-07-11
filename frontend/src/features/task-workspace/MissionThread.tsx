import { useEffect, useRef, type ReactNode } from 'react'
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
  entries: ConversationEntry[]
  live: boolean
  /** Rendered inside the plan card — approve/reject/replan, only while a decision is pending. */
  planActions?: ReactNode
  /** Rendered at the end of the thread — the one contextual next-step button. */
  actionRow?: ReactNode
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
  const passed = entry.overall === 'passed'
  const failed = entry.overall != null && entry.overall !== 'passed'
  return (
    <ArtifactCard
      icon="check"
      title={passed ? 'Validation passed' : failed ? 'Validation failed' : 'Validation running'}
      subtitle={`${entry.stages.filter((s) => s.state === 'passed').length}/${entry.stages.length} stages`}
      tone={passed ? 'success' : failed ? 'danger' : 'neutral'}
      defaultOpen={failed}
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

/**
 * The Mission page: one continuous conversation. The task intent opens the
 * thread; everything else — thinking, tool use, plan/files/validation/repair/
 * publish outcomes — appears as chronological entries, collapsed by default,
 * so backend phase names never surface as separate dashboard panels.
 */
export function MissionThread({ header, entries, live, planActions, actionRow, emptyLabel = 'Waiting for the agent…' }: MissionThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' })
  }, [entries.length])

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
          {entries.length === 0 && <div className={styles.empty}>{emptyLabel}</div>}
          {entries.map((entry, i) => {
            switch (entry.type) {
              case 'intent':
                return (
                  <div key={`intent-${i}`} className={styles.intent}>
                    {entry.text}
                  </div>
                )
              case 'work':
                return <ThoughtGroup key={entry.group.id} group={entry.group} isLive={entry.isLive} />
              case 'message':
                return <ActivityRow key={entry.event.id} ev={entry.event} />
              case 'plan':
                return <PlanEntry key={`plan-${i}`} entry={entry} actions={planActions} />
              case 'files':
                return <FilesEntry key={`files-${i}`} entry={entry} />
              case 'validation':
                return <ValidationEntry key={`validation-${i}`} entry={entry} />
              case 'repair':
                return <RepairEntry key={`repair-${i}`} entry={entry} />
              case 'publish':
                return <PublishEntry key={`publish-${i}`} entry={entry} />
              default:
                return null
            }
          })}
          {live && (
            <div className={styles.working}>
              <span className={styles.cursor}>▋</span> working…
            </div>
          )}
          {actionRow && <div className={styles.actionRow}>{actionRow}</div>}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  )
}
