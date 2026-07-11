import { createAction } from '@reduxjs/toolkit'
import type { ForgeSocketEvent, SocketChannel } from '@/types'

/**
 * Socket command + event actions. Commands (`wsConnect`/`wsDisconnect`) are
 * intercepted by the websocket middleware and never reach a reducer.
 * `socketEventReceived` is dispatched *by* the middleware and reduced by the
 * stream slice. Components only ever dispatch commands and read slice state —
 * they never touch a WebSocket directly.
 */

export interface WsConnectPayload {
  channel: SocketChannel
  resourceId: string
  token: string
  /** Extra path appended after the resource id (e.g. session stream path). */
  path: string
}

export const wsConnect = createAction<WsConnectPayload>('socket/connect')

export const wsDisconnect = createAction<{
  channel: SocketChannel
  resourceId: string
}>('socket/disconnect')

export const socketEventReceived = createAction<{
  channel: SocketChannel
  resourceId: string
  event: ForgeSocketEvent
}>('socket/eventReceived')
