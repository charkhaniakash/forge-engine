import { useEffect, type ReactNode } from 'react'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import { cn } from '@/lib/utils'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  side?: 'right' | 'left'
  width?: number
  footer?: ReactNode
  children: ReactNode
}

export function Drawer({
  open,
  onClose,
  title,
  side = 'right',
  width = 480,
  footer,
  children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-drawer)] flex bg-black/60 backdrop-blur-sm animate-in fade-in-0"
        onMouseDown={onClose}
      >
        <aside
          className={cn(
            'flex h-full max-w-[92vw] flex-col bg-card shadow-xl animate-in slide-in-from-right',
            side === 'right' ? 'ml-auto border-l border-line' : 'mr-auto border-r border-line',
          )}
          style={{ width }}
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {title && (
            <div className="flex items-center justify-between border-b border-line-subtle px-5 py-4">
              <div className="text-base font-semibold">{title}</div>
              <button
                className="cursor-pointer rounded-sm p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                onClick={onClose}
                aria-label="Close"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line-subtle px-5 py-4">
              {footer}
            </div>
          )}
        </aside>
      </div>
    </Portal>
  )
}
