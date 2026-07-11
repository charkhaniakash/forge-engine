/**
 * Runtime configuration. In dev, requests go through the Vite proxy (same
 * origin), so BACKEND_URL defaults to '' (relative). Set VITE_BACKEND_URL to
 * point at an absolute origin in other environments.
 */

const rawBackend = import.meta.env.VITE_BACKEND_URL ?? ''

/** Absolute or relative HTTP base for the REST API (no trailing slash). */
export const BACKEND_URL = rawBackend.replace(/\/$/, '')

/** API version prefix. */
export const API_PREFIX = '/v1'

/** Base path for RTK Query's fetchBaseQuery. */
export const API_BASE_URL = `${BACKEND_URL}${API_PREFIX}`

/**
 * Derive the WebSocket origin from the HTTP origin. When BACKEND_URL is
 * relative we fall back to the current page origin at call time.
 */
export function websocketBase(): string {
  const origin = BACKEND_URL || window.location.origin
  return origin.replace(/^http/, 'ws') + API_PREFIX
}

export const AUTH_TOKEN_KEY = 'forge.auth'
export const THEME_KEY = 'forge.theme'
