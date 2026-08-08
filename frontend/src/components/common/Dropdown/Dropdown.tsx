import { useRef, useState, type ReactNode } from 'react'
import { useClickOutside } from '@/hooks/useClickOutside'
import { cn } from '@/lib/utils'

export interface DropdownItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  /** Render a divider above this item. */
  divider?: boolean
}

export interface DropdownProps {
  /** The trigger element. Receives an onClick to toggle the menu. */
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  items: DropdownItem[]
  align?: 'start' | 'end'
  header?: ReactNode
  width?: number
}

export function Dropdown({ trigger, items, align = 'end', header, width = 220 }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)

  return (
    <div className="relative inline-flex" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className={cn(
            'absolute top-[calc(100%+6px)] z-[var(--z-drawer)] rounded-lg border border-line bg-surface-3 p-1 shadow-lg animate-in fade-in-0',
            align === 'end' ? 'right-0' : 'left-0',
          )}
          style={{ width }}
          role="menu"
        >
          {header && (
            <div className="mb-1 border-b border-line-subtle px-3 py-2 text-xs text-fg-subtle">
              {header}
            </div>
          )}
          {items.map((item) => (
            <div key={item.id}>
              {item.divider && <div className="my-1 border-t border-line-subtle" />}
              <button
                role="menuitem"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50',
                  item.danger
                    ? 'text-destructive enabled:hover:bg-destructive/10'
                    : 'text-fg enabled:hover:bg-surface-2',
                )}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.()
                  setOpen(false)
                }}
              >
                {item.icon && (
                  <span
                    className={cn('inline-flex', item.danger ? 'text-destructive' : 'text-fg-muted')}
                  >
                    {item.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
