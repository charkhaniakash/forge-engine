import { useCallback, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

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
      className={cn('flex h-full w-full overflow-hidden', isH ? 'flex-row' : 'flex-col')}
    >
      <div
        className="min-w-0 min-h-0 overflow-auto"
        style={isH ? { width: size, flex: '0 0 auto' } : { height: size, flex: '0 0 auto' }}
      >
        {first}
      </div>
      <div
        className={cn(
          'flex-shrink-0 bg-line transition-colors hover:bg-primary/40',
          isH
            ? 'w-px cursor-col-resize border-x-2 border-transparent bg-clip-padding'
            : 'h-px cursor-row-resize border-y-2 border-transparent bg-clip-padding',
        )}
        onMouseDown={start}
        role="separator"
      />
      <div className="min-w-0 min-h-0 flex-1 overflow-auto">{second}</div>
    </div>
  )
}
