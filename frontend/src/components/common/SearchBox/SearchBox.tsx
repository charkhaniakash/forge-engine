import { forwardRef, type InputHTMLAttributes } from 'react'
import { Icon } from '../Icon/Icon'
import { cn } from '@/lib/utils'

export interface SearchBoxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md'
  /** Optional trailing keyboard hint, e.g. "⌘K". */
  shortcut?: string
}

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(
  function SearchBox({ size = 'md', shortcut, className, ...rest }, ref) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-base px-3 transition-colors duration-150 focus-within:border-primary',
          size === 'sm' ? 'h-[30px]' : 'h-[34px]',
          className,
        )}
      >
        <Icon
          name="search"
          size={size === 'sm' ? 14 : 16}
          className="flex-shrink-0 text-fg-subtle"
        />
        <input
          ref={ref}
          className="min-w-0 flex-1 border-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:appearance-none"
          type="search"
          {...rest}
        />
        {shortcut && (
          <kbd className="rounded-sm border border-border bg-card px-2 py-px font-sans text-xs text-fg-subtle">
            {shortcut}
          </kbd>
        )}
      </div>
    )
  },
)
