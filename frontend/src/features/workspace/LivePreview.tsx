import { useEffect, useState } from 'react'
import { useAppSelector } from '@/app/hooks'
import { Icon, Spinner } from '@/components/common'
import styles from './workspace.module.css'

export function LivePreview() {
  const [previewUrl, setPreviewUrl] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const buildStatus = useAppSelector((s) => s.workspaceActivity?.buildStatus || 'idle')
  const previewPort = useAppSelector((s) => s.workspaceActivity?.previewPort)

  useEffect(() => {
    if (previewPort) {
      const url = `http://localhost:${previewPort}`
      setPreviewUrl(url)
      setIsLoading(true)
    }
  }, [previewPort])

  const statusMessages: Record<string, string> = {
    idle: 'Ready',
    compiling: 'Compiling...',
    success: 'Ready',
    error: 'Build Error',
  }

  const statusColors: Record<string, string> = {
    idle: '#666',
    compiling: '#3B82F6',
    success: '#10B981',
    error: '#EF4444',
  }

  return (
    <div className={styles.previewContainer}>
      <div className={styles.previewHeader}>
        <div className={styles.previewTitle}>
          <Icon name="monitor" size={16} />
          <span>Live Preview</span>
        </div>
        <div className={styles.previewStatus}>
          <span
            className={styles.statusDot}
            style={{ backgroundColor: statusColors[buildStatus] }}
          />
          <span style={{ fontSize: '12px', color: statusColors[buildStatus] }}>
            {statusMessages[buildStatus]}
          </span>
        </div>
      </div>

      {buildStatus === 'compiling' || isLoading ? (
        <div className={styles.previewLoading}>
          <Spinner size="md" />
          <p>
            {buildStatus === 'compiling' ? 'Compiling...' : 'Loading preview...'}
          </p>
        </div>
      ) : buildStatus === 'error' ? (
        <div className={styles.previewError}>
          <Icon name="alertCircle" size={32} />
          <p>Build Error</p>
          <span>Check the activity panel for details</span>
        </div>
      ) : previewUrl ? (
        <iframe
          src={previewUrl}
          className={styles.previewIframe}
          title="Live Preview"
          onLoad={() => setIsLoading(false)}
          sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
        />
      ) : (
        <div className={styles.previewEmpty}>
          <Icon name="box" size={32} />
          <p>No preview available</p>
          <span>Build will start automatically when files change</span>
        </div>
      )}
    </div>
  )
}
