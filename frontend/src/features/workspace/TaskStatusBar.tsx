import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import styles from './workspace.module.css'

const BUILD_COLORS: Record<string, string> = {
  idle: '#666',
  compiling: '#3B82F6',
  success: '#10B981',
  error: '#EF4444',
}

export function TaskStatusBar() {
  const activeFilePath = useAppSelector((s) => s.workspaceEditor?.activeFilePath)
  const connectionState = useAppSelector((s) => s.unifiedStream?.connectionState ?? 'idle')
  const collab = useAppSelector((s) => s.workspaceActivity?.collaboration)

  const phase = collab?.status ?? 'idle'
  const buildColor = BUILD_COLORS['idle']

  return (
    <div className={styles.statusBar}>
      <div className={styles.statusGroup}>
        <Icon name="file" size={14} />
        <span className={styles.statusLabel}>{activeFilePath ?? 'No file selected'}</span>
      </div>

      <div className={styles.statusDivider} />

      <div className={styles.statusGroup}>
        <Icon name="sparkles" size={8} />
        <span className={styles.statusLabel}>Phase: {phase}</span>
      </div>

      <div className={styles.statusDivider} />

      <div className={styles.statusGroup}>
        <Icon name="dot" size={14} style={{ color: buildColor }} />
        <span className={styles.statusLabel}>ready</span>
      </div>

      <div className={styles.statusDivider} />

      <div className={styles.statusGroup}>
        <span
          className={styles.connectionDot}
          style={{
            backgroundColor:
              connectionState === 'open'
                ? '#10B981'
                : connectionState === 'connecting'
                  ? '#F59E0B'
                  : '#EF4444',
          }}
        />
        <span className={styles.statusLabel}>{connectionState}</span>
      </div>

      <div style={{ flex: 1 }} />

      <div className={styles.statusGroup}>
        <span className={styles.timestamp}>{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
