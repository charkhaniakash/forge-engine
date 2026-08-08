import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface TabItem {
  id: string
  label: ReactNode
  count?: number
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  activeId: string
  onChange: (id: string) => void
  /** 'underline' (default) for page-level, 'pill' for compact toolbars. */
  variant?: 'underline' | 'pill'
}

export function Tabs({ items, activeId, onChange, variant = 'underline' }: TabsProps) {
  const isUnderline = variant === 'underline'
  return (
    <div
      className={cn(
        'flex items-center',
        isUnderline ? 'gap-4 border-b border-border' : 'gap-1',
      )}
      role="tablist"
    >
      {items.map((item) => {
        const active = item.id === activeId
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={cn(
              'relative inline-flex cursor-pointer items-center gap-2 border-none bg-transparent text-sm font-medium text-fg-subtle transition-colors duration-150 enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              isUnderline
                ? '-mb-px border-b-2 border-b-transparent px-1 py-3'
                : 'rounded-md px-3 py-2',
              active &&
                (isUnderline
                  ? 'border-b-primary text-fg'
                  : 'bg-surface-2 text-fg'),
            )}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count != null && (
              <span
                className={cn(
                  'rounded-full px-2 py-px text-xs',
                  active ? 'bg-primary/10 text-primary' : 'bg-surface-2 text-fg-muted',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
