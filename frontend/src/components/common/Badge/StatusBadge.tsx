import { Badge } from './Badge'
import { resolveStatus, type StatusMeta } from '@/constants/status'

export interface StatusBadgeProps {
  /** One of the maps from constants/status (e.g. WORK_ITEM_STATUS). */
  map: Record<string, StatusMeta>
  status: string | undefined | null
  dot?: boolean
  size?: 'sm' | 'md'
}

/** Resolves a raw backend status string to a toned Badge with a friendly label. */
export function StatusBadge({ map, status, dot = true, size = 'md' }: StatusBadgeProps) {
  const meta = resolveStatus(map, status)
  return (
    <Badge tone={meta.tone} dot={dot} size={size}>
      {meta.label}
    </Badge>
  )
}
