import { useEffect, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Icon } from '@/components/common'
import { CompactStep } from './ActivityRow'
import { formatDuration } from './normalize'
import type { WorkGroup } from './model'
import { cn } from '@/lib/utils'

export interface ThoughtGroupProps {
  group: WorkGroup
  isLive: boolean
}

/** A burst of consecutive reasoning/tool-use events, collapsible like a
 *  "Thought for Xs" block. Expanded while live, auto-collapses when done. */
export function ThoughtGroup({ group, isLive }: ThoughtGroupProps) {
  const verb = group.hasToolActivity ? 'Working' : 'Thinking'
  const duration = group.durationMs != null ? formatDuration(group.durationMs) : null

  const [open, setOpen] = useState(isLive)
  // Follow the live→done transition: open while streaming, tuck away when finished.
  useEffect(() => {
    setOpen(isLive)
  }, [isLive])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg">
      <CollapsibleTrigger
        className={cn(
          'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60',
        )}
      >
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {isLive ? (
            <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" className="text-success">
              <path d="M4 8.5l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="text-[13px] font-medium text-fg-muted">{verb}</span>
        {duration && !isLive && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle">
            {duration}
          </span>
        )}
        <Icon
          name="chevronRight"
          size={13}
          className="ml-auto text-fg-subtle transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 mt-0.5 space-y-0 border-l border-line-subtle pl-3">
          {group.events.map((ev) => <CompactStep key={ev.id} ev={ev} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
