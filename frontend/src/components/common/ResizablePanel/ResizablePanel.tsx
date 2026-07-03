import { useCallback, useRef, useState, type ReactNode } from 'react'
import styles from './ResizablePanel.module.css'

export interface ResizablePanelProps {
  direction?: 'horizontal' | 'vertical'
  /** Initial size of the first pane in px. */
  initialSize?: number
  minSize?: number
  maxSize?: number
  first: ReactNode
  second: ReactNode
}

/** Two-pane split with a draggable divider. Presentational only. */
export function ResizablePanel({
  direction = 'horizontal',
  initialSize = 280,
  minSize = 160,
  maxSize = 640,
  first,
  second,
}: ResizablePanelProps) {
  const [size, setSize] = useState(initialSize)
  const containerRef = useRef<HTMLDivElement>(null)

  // The drag session lives entirely in local closures created on mousedown, so
  // the move/up handlers can reference each other for teardown without any
  // shared render-time state.
  const start = useCallback(() => {
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const raw =
        direction === 'horizontal' ? e.clientX - rect.left : e.clientY - rect.top
      setSize(Math.min(maxSize, Math.max(minSize, raw)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, minSize, maxSize])

  const isH = direction === 'horizontal'
  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${isH ? styles.horizontal : styles.vertical}`}
    >
      <div
        className={styles.pane}
        style={isH ? { width: size, flex: '0 0 auto' } : { height: size, flex: '0 0 auto' }}
      >
        {first}
      </div>
      <div
        className={`${styles.divider} ${isH ? styles.dividerH : styles.dividerV}`}
        onMouseDown={start}
        role="separator"
      />
      <div className={`${styles.pane} ${styles.grow}`}>{second}</div>
    </div>
  )
}
