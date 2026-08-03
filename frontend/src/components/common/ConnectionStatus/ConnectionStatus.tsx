import { useAppSelector } from '@/app/hooks'
import type { ConnectionState } from '@/types/websocket'
import styles from './ConnectionStatus.module.css'

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
    <div className={`${styles.badge} ${styles[status.color]}`}>
      <span className={status.color === 'warning' ? styles.pulse : ''}>
        {status.icon}
      </span>
      <span className={styles.label}>{status.label}</span>
    </div>
  )
}
