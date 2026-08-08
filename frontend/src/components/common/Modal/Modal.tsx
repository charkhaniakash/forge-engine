import { useEffect, type ReactNode } from 'react'
import { Portal } from '../Portal/Portal'
import { Icon } from '../Icon/Icon'
import { cn } from '@/lib/utils'

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-[400px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[820px]',
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center overflow-y-auto bg-black/60 px-4 pt-[10vh] pb-4 backdrop-blur-sm animate-in fade-in-0"
        onMouseDown={onClose}
      >
        <div
          className={cn(
            'flex w-full max-h-[80vh] flex-col rounded-xl border border-line bg-card shadow-xl',
            SIZE[size],
          )}
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(title || description) && (
            <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
              <div>
                {title && <div className="text-base font-semibold">{title}</div>}
                {description && (
                  <div className="mt-0.5 text-[13px] text-fg-muted">{description}</div>
                )}
              </div>
              <button
                className="flex-shrink-0 cursor-pointer rounded-sm p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                onClick={onClose}
                aria-label="Close"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
          )}
          <div className="overflow-y-auto px-5 pb-5">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-line-subtle px-5 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </Portal>
  )
}
