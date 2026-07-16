/**
 * Runtime configuration. In dev, requests go through the Vite proxy (same
 * origin), so BACKEND_URL defaults to '' (relative). Set VITE_BACKEND_URL to
 * point at an absolute origin in other environments.
 */

const rawBackend = import.meta.env.VITE_BACKEND_URL ?? ''
console.log('[config] VITE_BACKEND_URL:', import.meta.env.VITE_BACKEND_URL)
console.log('[config] rawBackend:', rawBackend)

/** Absolute or relative HTTP base for the REST API (no trailing slash). */
export const BACKEND_URL = rawBackend.replace(/\/$/, '')
console.log('[config] BACKEND_URL:', BACKEND_URL)

/** API version prefix. */
export const API_PREFIX = '/v1'

/** Base path for RTK Query's fetchBaseQuery. */
export const API_BASE_URL = `${BACKEND_URL}${API_PREFIX}`

/**
 * Derive the WebSocket origin from the HTTP origin. Always use BACKEND_URL
 * for WebSocket connections since they don't go through the Vite proxy.
 */
export function websocketBase(): string {
  // In Docker, VITE_BACKEND_URL should be set to http://localhost:8080
  // If not set, fall back to window.location.origin (for local dev without Docker)
  const origin = BACKEND_URL || window.location.origin
  return origin.replace(/^http/, 'ws') + API_PREFIX
}

export const AUTH_TOKEN_KEY = 'forge.auth'
export const THEME_KEY = 'forge.theme'
