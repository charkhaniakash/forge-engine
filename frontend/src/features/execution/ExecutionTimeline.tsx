import { Timeline, Icon, type TimelineItemData } from '@/components/common'
import { resolveStatus, STEP_STATUS } from '@/constants/status'
import type { StepExecution } from '@/types'

export interface ExecutionTimelineProps {
  steps: StepExecution[]
  currentStepStableId?: string
  selectedId?: string
  onSelect: (step: StepExecution) => void
}

const MARKER = {
  completed: 'check',
  failed: 'x',
  running: 'play',
  deviated: 'alert',
  skipped: 'chevronRight',
  pending: 'dot',
} as const

function duration(step: StepExecution): string | undefined {
  if (!step.started_at || !step.completed_at) return undefined
  const ms = new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function ExecutionTimeline({
  steps,
  currentStepStableId,
  selectedId,
  onSelect,
}: ExecutionTimelineProps) {
  const items: TimelineItemData[] = steps.map((step) => {
    const meta = resolveStatus(STEP_STATUS, step.status)
    const isCurrent = step.step_stable_id === currentStepStableId
    return {
      id: step.id,
      tone: meta.tone,
      active: step.id === selectedId || isCurrent,
      marker: <Icon name={MARKER[step.status as keyof typeof MARKER] ?? 'dot'} size={9} />,
      title: (
        <span>
          <span style={{ color: 'var(--text-tertiary)', marginRight: 6 }}>
            #{step.step_order}
          </span>
          {step.step_stable_id}
        </span>
      ),
      meta: duration(step) ?? meta.label,
      onClick: () => onSelect(step),
    }
  })
  return <Timeline items={items} live={Boolean(currentStepStableId)} />
}
