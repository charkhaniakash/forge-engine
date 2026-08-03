import { useMemo } from 'react'
import type { TimelineItemData } from '../Timeline/Timeline'
import { Timeline } from '../Timeline/Timeline'
import {
  extractEventMetadata,
  formatTimestamp,
  sortBySequence,
  eventTone,
  isPhaseTransition,
} from '@/utils/eventMetadata'

export interface StreamEvent {
  seq?: number
  kind: string
  label?: string
  raw?: Record<string, any>
  receivedAt?: number
}

export interface EventTimelineProps {
  events: StreamEvent[]
  live?: boolean
  onEventClick?: (event: StreamEvent) => void
}

/**
 * Enhanced timeline that displays event metadata (seq, timestamp, phase).
 * Sorts events by sequence number for correct ordering.
 * Used for execution, validation, repair, and publishing streams.
 */
export function EventTimeline({
  events,
  live = false,
  onEventClick,
}: EventTimelineProps) {
  const timelineItems = useMemo(() => {
    // Sort by sequence first, ensuring correct order
    const sorted = sortBySequence(events)
    
    return sorted.map((event, idx) => {
      const metadata = extractEventMetadata(event.raw || {})
      const isPhaseEnd = isPhaseTransition(event.kind)
      const tone = eventTone(metadata.phase || '', event.kind)
      
      // Format: "Execution #42 · 14:30:45" or "execution_step · 14:30:45"
      const timeStr = metadata.formattedTime ? ` · ${metadata.formattedTime}` : ''
      const seqStr = metadata.seq !== undefined ? ` #${metadata.seq}` : ''
      const title = `${event.label || event.kind}${seqStr}`
      
      // Meta shows timestamp and phase if available
      const metaParts: string[] = []
      if (metadata.ts) metaParts.push(formatTimestamp(metadata.ts))
      if (metadata.phase && metadata.phase !== event.kind) {
        metaParts.push(metadata.phase)
      }
      
      const item: TimelineItemData = {
        id: metadata.id || `${event.kind}-${idx}`,
        tone,
        title,
        meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
        active: isPhaseEnd && live && idx === sorted.length - 1,
        onClick: () => onEventClick?.(event),
      }
      
      return item
    })
  }, [events, live, onEventClick])

  return <Timeline items={timelineItems} live={live} />
}
