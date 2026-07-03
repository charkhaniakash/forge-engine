/** Shared primitives used across the API layer. */

export type ID = string
export type ISODate = string

/** Error envelope returned by the Go backend on non-2xx responses. */
export interface ApiError {
  error: string
  code?: string
  details?: unknown
}

/** Async lifecycle for slice-owned (non-RTKQ) state. */
export type LoadStatus = 'idle' | 'loading' | 'succeeded' | 'failed'

export type RiskLevel = 'low' | 'medium' | 'high'
