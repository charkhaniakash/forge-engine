import { useState, type ReactNode } from 'react'
import { Icon } from '../Icon/Icon'
import { cn } from '@/lib/utils'

export interface AccordionProps {
  title: ReactNode
  subtitle?: ReactNode
  defaultOpen?: boolean
  right?: ReactNode
  children: ReactNode
  /** Extra class on the root — lets consumers fit the accordion into a denser context. */
  className?: string
}

export function Accordion({
  title,
  subtitle,
  defaultOpen = false,
  right,
  children,
  className,
}: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={cn('overflow-hidden rounded-md border border-border', className)}>
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-card px-4 py-3 text-left text-fg transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Icon
          name="chevronRight"
          size={16}
          className={cn(
            'flex-shrink-0 text-fg-subtle transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <span className="text-sm font-medium">{title}</span>
        {subtitle && <span className="text-xs text-fg-muted">{subtitle}</span>}
        {right && <span className="ml-auto">{right}</span>}
      </button>
      {open && (
        <div className="border-t border-line-subtle bg-base p-4">{children}</div>
      )}
    </div>
  )
}
