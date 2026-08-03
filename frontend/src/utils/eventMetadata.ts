/**
 * Event metadata formatting and utilities for Phase 2.
 * Handles timestamp formatting, sequence numbering, and phase tracking.
 */

export interface EventMetadata {
  id?: string
  seq?: number
  ts?: number
  phase?: string
  formattedTime?: string
  elapsedMs?: number
}

/**
 * Format Unix milliseconds as HH:MM:SS or HH:MM:SS.mmm
 * Example: 1609459200000 → "14:00:00"
 */
export function formatTimestamp(unixMs: number, includeMs = false): string {
  const date = new Date(unixMs)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  
  if (includeMs) {
    const ms = String(date.getMilliseconds()).padStart(3, '0')
    return `${hours}:${minutes}:${seconds}.${ms}`
  }
  return `${hours}:${minutes}:${seconds}`
}

/**
 * Calculate elapsed time from a start timestamp to now or another timestamp.
 * Returns string like "2.3s" or "120ms"
 */
export function formatElapsed(startMs: number, endMs = Date.now()): string {
  const diff = endMs - startMs
  if (diff < 1000) {
    return `${Math.round(diff)}ms`
  }
  return `${(diff / 1000).toFixed(1)}s`
}

/**
 * Extract and normalize event metadata from a raw event object.
 * Handles both unified envelopes and legacy event formats.
 */
export function extractEventMetadata(event: Record<string, any>): EventMetadata {
  return {
    id: event.id || event.event_id,
    seq: typeof event.seq === 'number' ? event.seq : undefined,
    ts: typeof event.ts === 'number' ? event.ts : undefined,
    phase: event.phase || event.ev,
    formattedTime: event.ts ? formatTimestamp(event.ts) : undefined,
  }
}

/**
 * Sort events by sequence number, falling back to arrival order if seq is missing.
 * Ensures consistent ordering even with late-arriving events.
 */
export function sortBySequence<T extends { seq?: number; receivedAt?: number }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const seqA = a.seq ?? Number.MAX_SAFE_INTEGER
    const seqB = b.seq ?? Number.MAX_SAFE_INTEGER
    if (seqA !== seqB) return seqA - seqB
    const timeA = a.receivedAt ?? 0
    const timeB = b.receivedAt ?? 0
    return timeA - timeB
  })
}

/**
 * Create a human-readable event summary for UI display.
 * Example: "Execution #42 · execution_complete · 14:30:45"
 */
export function summarizeEvent(
  phase: string,
  eventType: string,
  seq?: number,
  ts?: number,
): string {
  const parts: string[] = []
  
  if (seq !== undefined) {
    parts.push(`#${seq}`)
  }
  
  if (phase) {
    parts.push(phase)
  }
  
  if (eventType) {
    const readable = eventType
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
    parts.push(readable)
  }
  
  if (ts) {
    parts.push(formatTimestamp(ts))
  }
  
  return parts.filter(Boolean).join(' · ')
}

/**
 * Group events by phase for timeline display.
 * Returns map of phase → sorted events.
 */
export function groupEventsByPhase<T extends { phase?: string; seq?: number; receivedAt?: number }>(
  events: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  
  for (const event of events) {
    const phase = event.phase || 'unknown'
    if (!grouped.has(phase)) {
      grouped.set(phase, [])
    }
    grouped.get(phase)!.push(event)
  }
  
  // Sort each group by sequence
  for (const phase of grouped.keys()) {
    grouped.set(phase, sortBySequence(grouped.get(phase)!))
  }
  
  return grouped
}

/**
 * Check if an event represents a phase transition.
 * Examples: execution_complete, validation_started, repair_complete
 */
export function isPhaseTransition(eventType: string): boolean {
  const transitionEvents = new Set([
    'execution_started',
    'execution_complete',
    'validation_started',
    'validation_complete',
    'repair_started',
    'repair_complete',
    'publishing_started',
    'publishing_complete',
  ])
  return transitionEvents.has(eventType)
}

/**
 * Assign a visual tone/color to an event based on phase and type.
 */
export function eventTone(
  phase: string,
  eventType: string,
): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  if (eventType.includes('error') || eventType.includes('failed')) return 'error'
  if (eventType.includes('warning')) return 'warning'
  if (eventType.includes('complete')) return 'success'
  if (eventType.includes('started') || eventType.includes('running')) return 'info'
  return 'neutral'
}
