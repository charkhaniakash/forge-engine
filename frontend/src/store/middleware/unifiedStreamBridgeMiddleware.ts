import type { Middleware } from '@reduxjs/toolkit'
import { unifiedStreamEnvelopeReceived } from '@/store/slices/unifiedStreamSlice'
import {
  appendExecutionEvent,
  appendValidationEvent,
  appendRepairEvent,
  appendPublishingEvent,
} from '@/store/slices/streamSlice'
import type { UnifiedStreamEnvelope } from '@/types/websocket'
import type { ExecutionSocketEvent, ValidationSocketEvent } from '@/types'
import type { RepairSocketEvent } from '@/types/repair'
import type { PublishingSocketEvent } from '@/types/publishing'

/**
 * Bridge middleware that translates unified stream envelopes into existing
 * event types and dispatches them to the appropriate stream reducers.
 *
 * This allows the new unified stream to coexist with existing components that
 * expect the old event format, providing a smooth migration path.
 *
 * Eventually, components should be updated to consume events directly from
 * the unified stream slice, and this middleware can be removed.
 */
export const unifiedStreamBridgeMiddleware: Middleware = (store) => {
  return (next) => (action) => {
    if (unifiedStreamEnvelopeReceived.match(action)) {
      const envelope: UnifiedStreamEnvelope = action.payload

      // Translate unified envelope to legacy event format based on channel
      switch (envelope.ch) {
        case 'execution': {
          const event: ExecutionSocketEvent = {
            event: envelope.ev,
            ...envelope.payload,
            seq: envelope.seq,
            ts: envelope.ts,
            id: envelope.id,
            phase: envelope.phase,
          }
          store.dispatch(
            appendExecutionEvent({ sessionId: 'default', event }),
          )
          break
        }

        case 'validation': {
          const event: ValidationSocketEvent = {
            event: envelope.ev,
            ...envelope.payload,
            seq: envelope.seq,
            ts: envelope.ts,
            id: envelope.id,
            phase: envelope.phase,
          }
          store.dispatch(
            appendValidationEvent({ sessionId: 'default', event }),
          )
          break
        }

        case 'repair': {
          const event: RepairSocketEvent = {
            event: envelope.ev as RepairSocketEvent['event'],
            ts: envelope.ts,
            ...(envelope.payload ?? {}),
          }
          store.dispatch(appendRepairEvent({ sessionId: 'default', event }))
          break
        }

        case 'publishing': {
          const event: PublishingSocketEvent = {
            v: 1,
            event: envelope.ev as PublishingSocketEvent['event'],
            session_id: '',
            ts: envelope.ts,
            ...(envelope.payload ?? {}),
          }
          store.dispatch(appendPublishingEvent({ sessionId: 'default', event }))
          break
        }

        default:
          // Unknown channel, ignore
          break
      }
    }

    return next(action)
  }
}
