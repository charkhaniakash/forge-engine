import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Renders children into document.body via a portal (client-only app). */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
