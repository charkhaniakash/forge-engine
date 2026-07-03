import { useEffect, useRef } from 'react'
import styles from './LogViewer.module.css'

export interface LogLine {
  id?: string | number
  text: string
  tone?: 'default' | 'info' | 'success' | 'warning' | 'error' | 'muted'
}

export interface LogViewerProps {
  lines: LogLine[]
  /** Auto-scroll to the newest line as lines arrive. */
  follow?: boolean
  /** Show a blinking "live" cursor at the bottom. */
  live?: boolean
  maxHeight?: number
  emptyLabel?: string
}

const TONE: Record<NonNullable<LogLine['tone']>, string> = {
  default: styles.default,
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  error: styles.error,
  muted: styles.muted,
}

/** Terminal-style streaming log surface. */
export function LogViewer({
  lines,
  follow = true,
  live = false,
  maxHeight = 220,
  emptyLabel = 'No output yet.',
}: LogViewerProps) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines.length, follow])

  return (
    <div className={styles.root} style={{ maxHeight }}>
      {lines.length === 0 && !live && <div className={styles.empty}>{emptyLabel}</div>}
      {lines.map((line, i) => (
        <div key={line.id ?? i} className={`${styles.line} ${TONE[line.tone ?? 'default']}`}>
          {line.text}
        </div>
      ))}
      {live && <div className={styles.cursor}>▋</div>}
      <div ref={endRef} />
    </div>
  )
}
