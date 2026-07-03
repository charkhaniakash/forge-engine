import { Drawer, Badge, DiffViewer, EmptyState, Icon, StatusBadge } from '@/components/common'
import { ReasoningPanel } from './ReasoningPanel'
import { ToolCallCard } from './ToolCallCard'
import { STEP_STATUS } from '@/constants/status'
import type { CodeDiff, ExecutionEvent, StepExecution } from '@/types'
import styles from './execution.module.css'

export interface StepDetailDrawerProps {
  step: StepExecution | null
  events: ExecutionEvent[]
  diffs: CodeDiff[]
  onClose: () => void
}

export function StepDetailDrawer({ step, events, diffs, onClose }: StepDetailDrawerProps) {
  const stepEvents = step
    ? events.filter((e) => e.step_stable_id === step.step_stable_id)
    : []
  const toolEvents = stepEvents.filter(
    (e) => e.event_type === 'tool_call' || e.event_type === 'tool_result',
  )

  return (
    <Drawer
      open={Boolean(step)}
      onClose={onClose}
      width={560}
      title={step ? `Step #${step.step_order}` : 'Step'}
    >
      {step && (
        <div className={styles.detail}>
          <div className={styles.detailHead}>
            <code className={styles.stableId}>{step.step_stable_id}</code>
            <StatusBadge map={STEP_STATUS} status={step.status} />
          </div>

          <ReasoningPanel reasoning={step.reasoning} />

          {step.deviation_note && (
            <div className={styles.deviation}>
              <Icon name="alert" size={14} />
              <div>
                <strong>Deviation</strong>
                <p>{step.deviation_note}</p>
              </div>
            </div>
          )}

          <div className={styles.block}>
            <div className={styles.blockHead}>
              <Icon name="tool" size={14} /> Tool calls
              <Badge tone="neutral" size="sm">{toolEvents.length}</Badge>
            </div>
            {toolEvents.length === 0 ? (
              <p className={styles.muted}>No tool calls recorded for this step.</p>
            ) : (
              <div className={styles.toolList}>
                {toolEvents.map((e) => (
                  <ToolCallCard
                    key={e.id}
                    tool={e.tool_name ?? e.event_type}
                    args={e.payload}
                    success={e.event_type === 'tool_result' ? true : undefined}
                    result={e.event_type === 'tool_result' ? e.message : undefined}
                  />
                ))}
              </div>
            )}
          </div>

          <div className={styles.block}>
            <div className={styles.blockHead}>
              <Icon name="code" size={14} /> Code changes
              <Badge tone="neutral" size="sm">{diffs.length}</Badge>
            </div>
            {diffs.length === 0 ? (
              <p className={styles.muted}>No file changes attributed to this step.</p>
            ) : (
              diffs.map((d) => (
                <div key={d.id} className={styles.diffBlock}>
                  <div className={styles.diffName}>
                    <code>{d.file_path}</code>
                    <span>
                      <span className={styles.add}>+{d.lines_added}</span>{' '}
                      <span className={styles.del}>-{d.lines_removed}</span>
                    </span>
                  </div>
                  {d.diff_unified && <DiffViewer diff={d.diff_unified} hideFileHeader maxHeight={280} />}
                </div>
              ))
            )}
          </div>

          {!step.reasoning && toolEvents.length === 0 && diffs.length === 0 && (
            <EmptyState
              compact
              icon={<Icon name="clock" size={28} />}
              title="Nothing recorded yet"
              description="Detail appears as this step executes."
            />
          )}
        </div>
      )}
    </Drawer>
  )
}
