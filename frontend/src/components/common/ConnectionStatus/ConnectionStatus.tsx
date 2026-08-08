import { useAppSelector } from '@/app/hooks'
import type { ConnectionState } from '@/types/websocket'
import { cn } from '@/lib/utils'

const COLOR_CLASSES: Record<string, string> = {
  success:
    'bg-success/10 text-success border-success/30 hover:bg-success/15 hover:border-success/50',
  warning:
    'bg-warning/10 text-warning border-warning/30 hover:bg-warning/15 hover:border-warning/50',
  error:
    'bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/15 hover:border-destructive/50',
  default: 'text-fg-subtle border-line',
}

/**
 * Real-time connection status indicator.
 * Shows Live ✓, Connecting..., or Offline ✗ with color coding.
 */
export function ConnectionStatus() {
  const connectionState = useAppSelector((s) => s.unifiedStream?.connectionState ?? 'idle')

  const getStatusInfo = (state: ConnectionState) => {
    switch (state) {
      case 'open':
        return { label: 'Live', color: 'success', icon: '✓' }
      case 'connecting':
      case 'reconnecting':
        return { label: 'Connecting...', color: 'warning', icon: '⟳' }
      case 'closed':
      case 'idle':
        return { label: 'Offline', color: 'error', icon: '✗' }
      default:
        return { label: 'Unknown', color: 'default', icon: '?' }
    }
  }

  const status = getStatusInfo(connectionState)

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-all duration-200',
        COLOR_CLASSES[status.color],
      )}
    >
      <span className={status.color === 'warning' ? 'inline-block animate-pulse' : ''}>
        {status.icon}
      </span>
      <span className="whitespace-nowrap">{status.label}</span>
    </div>
  )
}
