import { useAppSelector } from '@/app/hooks'
import { cn } from '@/lib/utils'

function dotClass(status: string): string {
  if (status === 'success' || status === 'completed' || status === 'passed') return 'bg-success'
  if (status === 'failed' || status === 'error') return 'bg-destructive'
  if (status === 'running' || status === 'pending') return 'bg-warning'
  return 'bg-fg-subtle'
}

export function TimelinePanel() {
  const timeline = useAppSelector((s) => s.workspaceActivity.timeline)

  if (timeline.length === 0) {
    return (
      <div className="p-4 text-xs text-fg-subtle">
        No activity yet. Timeline events appear here as the agent works.
      </div>
    )
  }

  return (
    <div className="flex flex-col p-2">
      {timeline.map((e) => (
        <div key={e.id} className="flex gap-2.5 px-2 py-1.5">
          <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', dotClass(e.status))} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg">
              {e.phase}{e.step && e.step !== e.phase ? ` · ${e.step}` : ''}
            </div>
            {e.detail && <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">{e.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
