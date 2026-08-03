import { useAppSelector } from '@/app/hooks'
import { Icon } from '@/components/common'
import styles from './workspace.module.css'

export function TaskStatusBar() {
  const currentFile = useAppSelector((s) => s.workspaceEditor?.activeFile)
  const buildStatus = useAppSelector((s) => s.workspaceActivity?.buildStatus || 'idle')
  const currentPhase = useAppSelector((s) => s.workspaceActivity?.currentPhase || 'planning')
  const connectionState = useAppSelector((s) => s.unifiedStream?.connectionState || 'idle')

  const phaseColors: Record<string, string> = {
    planning: 'planning',
    executing: 'executing',
    validation: 'validation',
    repair: 'repair',
    publishing: 'publishing',
  }

  const buildIcons: Record<string, string> = {
    idle: 'circle',
    compiling: 'loader',
    success: 'checkCircle',
    error: 'alertCircle',
  }

  const buildColors: Record<string, string> = {
    idle: '#666',
    compiling: '#3B82F6',
    success: '#10B981',
    error: '#EF4444',
  }

  return (
    <div className={styles.statusBar}>
      <div className={styles.statusGroup}>
        <Icon name="file" size={14} />
        <span className={styles.statusLabel}>{currentFile || 'No file selected'}</span>
      </div>

      <div className={styles.statusDivider} />

      <div className={styles.statusGroup}>
        <Icon name="circle" size={8} />
        <span className={styles.statusLabel}>Phase: {currentPhase}</span>
      </div>

      <div className={styles.statusDivider} />

      <div className={styles.statusGroup}>
        <Icon
          name={buildIcons[buildStatus]}
          size={14}
          style={{ color: buildColors[buildStatus] }}
        />
        <span className={styles.statusLabel}>{buildStatus}</span>
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
