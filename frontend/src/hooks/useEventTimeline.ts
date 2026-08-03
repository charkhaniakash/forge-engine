import { useMemo } from 'react'
import { useAppSelector } from '@/app/hooks'
import type { ExecutionLiveEvent, ValidationLiveEvent } from '@/store/slices/streamSlice'
import { sortBySequence } from '@/utils/eventMetadata'

export interface UseEventTimelineOptions {
  sessionId: string
  phase: 'execution' | 'validation' | 'repair' | 'publishing'
}

/**
 * Custom hook to retrieve and sort events from Redux stream state.
 * Automatically handles sorting by sequence number.
 * Used by TaskWorkspace to feed event data to EventTimeline.
 */
export function useEventTimeline({ sessionId, phase }: UseEventTimelineOptions) {
  const events = useAppSelector((state) => {
    switch (phase) {
      case 'execution':
        return state.stream.execution[sessionId]?.events || []
      case 'validation':
        return state.stream.validation[sessionId]?.events || []
      case 'repair':
        return state.stream.repair[sessionId]?.events || []
      case 'publishing':
        return state.stream.publishing[sessionId]?.events || []
      default:
        return []
    }
  })

  const complete = useAppSelector((state) => {
    switch (phase) {
      case 'execution':
        return state.stream.execution[sessionId]?.complete || false
      case 'validation':
        return state.stream.validation[sessionId]?.complete || false
      case 'repair':
        return state.stream.repair[sessionId]?.complete || false
      case 'publishing':
        return state.stream.publishing[sessionId]?.complete || false
      default:
        return false
    }
  })

  // Sort events by sequence, ensuring correct order even with late arrivals
  const sortedEvents = useMemo(() => sortBySequence(events), [events])

  return {
    events: sortedEvents,
    complete,
    live: !complete,
  }
}
