import { useMemo } from 'react'
import { useAppSelector } from '@/app/hooks'

export interface UseEventTimelineOptions {
  sessionId: string
  phase: 'execution' | 'validation' | 'repair' | 'publishing'
}

/** Sort any array of objects that may have a numeric `seq` field. */
function sortBySeq<T extends Record<string, unknown>>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const seqA = typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER
    const seqB = typeof b.seq === 'number' ? b.seq : Number.MAX_SAFE_INTEGER
    return seqA - seqB
  })
}

/**
 * Retrieve and sort events from Redux stream state for a given phase/session.
 */
export function useEventTimeline({ sessionId, phase }: UseEventTimelineOptions) {
  const events = useAppSelector((state) => {
    switch (phase) {
      case 'execution':
        return state.stream.execution[sessionId]?.events ?? []
      case 'validation':
        return state.stream.validation[sessionId]?.events ?? []
      case 'repair':
        return state.stream.repair[sessionId]?.events ?? []
      case 'publishing':
        return state.stream.publishing[sessionId]?.events ?? []
      default:
        return []
    }
  }) as unknown as Record<string, unknown>[]

  const complete = useAppSelector((state) => {
    switch (phase) {
      case 'execution':
        return state.stream.execution[sessionId]?.complete ?? false
      case 'validation':
        return state.stream.validation[sessionId]?.complete ?? false
      case 'repair':
        return state.stream.repair[sessionId]?.complete ?? false
      case 'publishing':
        return state.stream.publishing[sessionId]?.complete ?? false
      default:
        return false
    }
  })

  const sortedEvents = useMemo(() => sortBySeq(events), [events])

  return { events: sortedEvents, complete, live: !complete }
}
